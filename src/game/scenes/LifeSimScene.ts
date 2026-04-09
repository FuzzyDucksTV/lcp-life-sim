import Phaser from 'phaser';
import { parsePlayerCommand } from '../sim/commandParser';
import { runtimeContract, getWorldSizeFromContract, resolveTaskTargetCells } from '../sim/contract';
import { createNavigationGrid, findNearestWalkableCell, findPathBfs, cellToWorldCenter, pickRandomWalkableCell, worldToCell, type NavigationGrid } from '../sim/navigation';
import { loadOrCreateIdentity, loadSnapshot, saveSnapshot } from '../sim/saveState';
import { getComplianceChance, onCommandAccepted, onCommandRejected, tickMood } from '../sim/mood';
import type { CellKey, CommandLogEntry, ManIdentity, NpcTask, TaskType } from '../types';

const DAY_DURATION_MS = 15 * 60 * 1000;
const PROFILE_REFRESH_INTERVAL_MS = 2_000;
const MAN_MOVE_SPEED = 74;
const DOG_MOVE_SPEED = 86;
const INTERRUPT_PRIORITY_PLAYER = 80;
const INTERRUPT_PRIORITY_DOOR = 100;

interface NpcRuntime {
  id: 'man' | 'dog';
  sprite: Phaser.GameObjects.Sprite;
  path: CellKey[];
  currentTask: NpcTask;
  performUntilMs: number;
  moveSpeed: number;
  hiddenUntilMs: number;
  pendingTargetCell: CellKey | null;
}

interface TaskTargets {
  chair: CellKey | null;
  computerDesk: CellKey | null;
  runningMachine: CellKey | null;
  piano: CellKey | null;
  letterDesk: CellKey | null;
  door: CellKey | null;
}

interface AnimationSpec {
  animationKey: string;
  texture: string;
  fallbackTexture?: string;
  frameCount: number;
  framesPerRow?: number;
  frameRate: number;
}

interface OcclusionZone {
  x: number;
  y: number;
  width: number;
  height: number;
  mode?: 'hide' | 'show';
}

interface RoutineBeat {
  startRatio: number;
  endRatio: number;
  label: string;
  task: TaskType;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function weightedChoiceByRoll<T>(options: Array<{ value: T; weight: number }>, roll: number): T {
  const total = options.reduce((sum, option) => sum + Math.max(0, option.weight), 0);
  if (total <= 0) {
    return options[0].value;
  }

  let target = clamp(roll, 0, 0.999999) * total;
  for (const option of options) {
    target -= Math.max(0, option.weight);
    if (target <= 0) {
      return option.value;
    }
  }

  return options[options.length - 1].value;
}

function getDirection(dx: number, dy: number): 'left' | 'right' | 'up' | 'down' {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? 'left' : 'right';
  }
  return dy < 0 ? 'up' : 'down';
}

function textForTask(task: TaskType): string {
  switch (task) {
    case 'pet_dog':
      return 'pet the dog';
    case 'idle_stand':
      return 'stand for a while';
    case 'sit_chair':
      return 'sit in a chair';
    case 'use_computer':
      return 'use the computer';
    case 'type_letter':
      return 'type a letter';
    case 'use_running_machine':
      return 'use the running machine';
    case 'play_piano':
      return 'play piano';
    case 'play_another_song':
      return 'play another song';
    case 'dance':
      return 'dance';
    case 'door_delivery':
      return 'check the door';
    default:
      return 'do something';
  }
}

export default class LifeSimScene extends Phaser.Scene {
  private identity!: ManIdentity;
  private grid!: NavigationGrid;
  private man!: NpcRuntime;
  private dog!: NpcRuntime;
  private taskTargets!: TaskTargets;
  private manTaskQueue: NpcTask[] = [];
  private interruptedTaskStack: NpcTask[] = [];
  private commandOutcomes: boolean[] = [];
  private dayIndex = 1;
  private dayElapsedMs = 0;
  private autoDeliveryTriggered = false;
  private deliveryQueued = false;
  private ringBellCount = 0;
  private lastProfilePushAt = 0;
  private lastRoutineBeatIndex = -1;
  private dogInteractionCooldownUntilMs = 0;
  private doorPhase: 'none' | 'to_door' | 'opening' | 'outside' | 'returning' = 'none';
  private preparedSpriteSheets = new Set<string>();
  private missingOptionalTextures = new Set<string>();

  private readonly routineBeats: readonly RoutineBeat[] = [
    { startRatio: 0, endRatio: 0.1, label: 'wake and orient', task: 'idle_stand' },
    { startRatio: 0.1, endRatio: 0.23, label: 'morning movement', task: 'use_running_machine' },
    { startRatio: 0.23, endRatio: 0.38, label: 'desk time', task: 'use_computer' },
    { startRatio: 0.38, endRatio: 0.52, label: 'letter writing', task: 'type_letter' },
    { startRatio: 0.52, endRatio: 0.67, label: 'break and music', task: 'play_piano' },
    { startRatio: 0.67, endRatio: 0.82, label: 'rest in chair', task: 'sit_chair' },
    { startRatio: 0.82, endRatio: 0.92, label: 'free time', task: 'wander' },
    { startRatio: 0.92, endRatio: 1.01, label: 'night rest', task: 'sleep' },
  ];

  private readonly animationSpecs: readonly AnimationSpec[] = [
    { animationKey: 'man-anim-walk-down', texture: 'man-walk-down', frameCount: 16, framesPerRow: 4, frameRate: 10 },
    { animationKey: 'man-anim-walk-up', texture: 'man-walk-up', frameCount: 16, framesPerRow: 4, frameRate: 10 },
    { animationKey: 'man-anim-walk-left', texture: 'man-walk-left', frameCount: 16, framesPerRow: 4, frameRate: 10 },
    { animationKey: 'man-anim-walk-right', texture: 'man-walk-right', frameCount: 16, framesPerRow: 4, frameRate: 10 },
    {
      animationKey: 'man-anim-idle-stand',
      texture: 'man-idle-stand',
      fallbackTexture: 'man-walk-down',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 4,
    },
    {
      animationKey: 'man-anim-sit-chair',
      texture: 'man-sit-chair',
      fallbackTexture: 'man-sleep',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 5,
    },
    {
      animationKey: 'man-anim-use-computer',
      texture: 'man-use-computer',
      fallbackTexture: 'man-use-object',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 9,
    },
    { animationKey: 'man-anim-sleep', texture: 'man-sleep', frameCount: 16, framesPerRow: 4, frameRate: 6 },
    { animationKey: 'man-anim-use-object', texture: 'man-use-object', frameCount: 36, framesPerRow: 6, frameRate: 14 },
    { animationKey: 'dog-anim-walk-down', texture: 'dog-walk-down', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-up', texture: 'dog-walk-up', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-left', texture: 'dog-walk-left', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-right', texture: 'dog-walk-right', frameCount: 16, framesPerRow: 4, frameRate: 12 },
  ];

  constructor() {
    super('LifeSimScene');
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      if (file.key === 'man-idle-stand' || file.key === 'man-sit-chair' || file.key === 'man-use-computer') {
        this.missingOptionalTextures.add(file.key);
      }
    });

    this.load.image('background', '/background/house-background.png');

    this.load.image('man-walk-down', '/sprites/man-walking-down.png');
    this.load.image('man-walk-up', '/sprites/man-walking-up.png');
    this.load.image('man-walk-left', '/sprites/man-walking-left.png');
    this.load.image('man-walk-right', '/sprites/man-walking-right.png');
    this.load.image('man-sleep', '/sprites/man-sleeping.png');
    this.load.image('man-use-object', '/sprites/man-using-object.png');
    // Optional dedicated clips for Phase 6.1b. If files are missing, runtime fallbacks are used.
    this.load.image('man-idle-stand', '/sprites/man-idle-stand.png');
    this.load.image('man-sit-chair', '/sprites/man-sit-chair.png');
    this.load.image('man-use-computer', '/sprites/man-use-computer.png');

    this.load.image('dog-walk-down', '/sprites/dog-walking-down.png');
    this.load.image('dog-walk-up', '/sprites/dog-walking-up.png');
    this.load.image('dog-walk-left', '/sprites/dog-walking-left.png');
    this.load.image('dog-walk-right', '/sprites/dog-walking-right.png');
  }

  create(): void {
    const snapshot = loadSnapshot();
    this.identity = snapshot?.manIdentity || loadOrCreateIdentity();
    this.dayIndex = snapshot?.dayIndex || 1;

    const worldSize = getWorldSizeFromContract();

    const background = this.add.image(0, 0, 'background').setOrigin(0, 0);
    background.setDisplaySize(worldSize.width, worldSize.height);

    this.cameras.main.setBounds(0, 0, worldSize.width, worldSize.height);
    this.physics.world.setBounds(0, 0, worldSize.width, worldSize.height);

    this.grid = createNavigationGrid(runtimeContract);
    this.taskTargets = resolveTaskTargetCells(this.grid);

    const manSpawn = runtimeContract.npcs.find((npc) => npc.id === 'man')?.spawn || { x: 1280, y: 1030 };
    const dogSpawn = runtimeContract.npcs.find((npc) => npc.id === 'dog')?.spawn || { x: 860, y: 1037 };

    this.prepareAllAnimations();

    const manScale = this.getSuggestedScale('man-walk-down', 128);
    const dogScale = this.getSuggestedScale('dog-walk-down', 90);

    this.man = {
      id: 'man',
      sprite: this.add.sprite(manSpawn.x, manSpawn.y, 'man-walk-down', 0).setScale(manScale),
      path: [],
      currentTask: { type: 'idle', source: 'system', priority: 0, resumable: false },
      performUntilMs: 0,
      moveSpeed: MAN_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.dog = {
      id: 'dog',
      sprite: this.add.sprite(dogSpawn.x, dogSpawn.y, 'dog-walk-down', 0).setScale(dogScale),
      path: [],
      currentTask: { type: 'wander', source: 'system', priority: 0, resumable: false },
      performUntilMs: 0,
      moveSpeed: DOG_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.playManIdle();
    this.playDogIdle();

    this.emitLog('system', `${this.identity.name} moved in. Personality locked for this life.`);
    this.emitLog('system', 'Simulation hidden mode enabled. Use Ring Bell or polite commands.');
    this.emitLog('system', 'Phase 6.2 enabled: deterministic routine, interrupt/resume tasks, and dog interaction beats.');
    this.reportOptionalAnimationFallbacks();
    this.runStartupAudit();
    this.emitProfile();
  }

  update(time: number, delta: number): void {
    const deltaMs = Math.min(delta, 50);

    this.advanceDay(deltaMs);
    this.tickMan(deltaMs, time);
    this.tickDog(deltaMs, time);

    this.identity.mood = tickMood(this.identity.mood, deltaMs, this.man.currentTask.type);

    if (time - this.lastProfilePushAt > PROFILE_REFRESH_INTERVAL_MS) {
      this.emitProfile();
      this.lastProfilePushAt = time;
    }

    this.applyOcclusionVisibility(this.man);
    this.applyOcclusionVisibility(this.dog);
    this.man.sprite.depth = this.man.sprite.y;
    this.dog.sprite.depth = this.dog.sprite.y;
  }

  public ringBell(): void {
    this.ringBellCount += 1;
    if (!this.isTaskAvailable('door_delivery')) {
      this.emitLog('system', 'Door flow is not configured in this layout.');
      this.emitAudioCue('negative');
      return;
    }

    if (this.deliveryQueued || this.doorPhase !== 'none' || this.man.currentTask.type === 'door_delivery') {
      this.emitLog('system', 'The bell rings, but a delivery is already in progress.');
      this.emitAudioCue('negative');
      return;
    }

    this.deliveryQueued = true;
    this.emitLog('player', 'Please come to the door.');
    this.emitLog('man', `${this.identity.name} heard the bell and will check the door.`);
    this.emitAudioCue('bell');
    this.requestPriorityTask(
      { type: 'door_delivery', source: 'system', priority: INTERRUPT_PRIORITY_DOOR, resumable: false },
      'door delivery'
    );
  }

  public submitPlayerCommand(rawInput: string): void {
    const command = parsePlayerCommand(rawInput);
    this.emitLog('player', rawInput);

    if (!command.isUnderstood) {
      this.emitLog('system', command.feedback);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.recordCommandOutcome(false);
      this.emitAudioCue('negative');
      this.emitProfile();
      return;
    }

    if (!command.intent) {
      this.emitLog('man', 'He nods politely but does not change his routine.');
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.emitProfile();
      return;
    }

    const accepts = this.rollCommandAcceptance(command.intent);
    if (!accepts) {
      this.emitLog('man', `${this.identity.name} seems unwilling right now.`);
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.emitProfile();
      return;
    }

    const intendedTask = this.resolveTaskWithAvailability(command.intent);
    if (intendedTask !== command.intent) {
      this.emitLog('system', `That request is unavailable in this layout. Falling back to ${textForTask(intendedTask)}.`);
    }

    this.requestPriorityTask(
      {
        type: intendedTask,
        fromPlayerCommand: command.normalized,
        source: 'player',
        priority: INTERRUPT_PRIORITY_PLAYER,
        resumable: true,
      },
      'player command'
    );
    this.emitLog('man', `Okay, I will ${textForTask(intendedTask)}.`);
    this.recordCommandOutcome(true);
    this.identity.mood = onCommandAccepted(this.identity.mood);
    this.emitAudioCue('positive');
    this.emitProfile();
  }

  private prepareAllAnimations(): void {
    this.animationSpecs.forEach((spec) => {
      const texture = this.resolveTexture(spec.texture, spec.fallbackTexture);
      this.prepareSpriteSheet(texture, spec.frameCount, spec.framesPerRow);
      this.createLoopAnimation(spec.animationKey, texture, spec.frameCount, spec.frameRate);
    });
  }

  private resolveTexture(primary: string, fallback?: string): string {
    if (this.textures.exists(primary)) {
      return primary;
    }
    if (fallback && this.textures.exists(fallback)) {
      return fallback;
    }
    return primary;
  }

  private prepareSpriteSheet(textureKey: string, frameCount: number, framesPerRow?: number): void {
    if (!this.textures.exists(textureKey) || this.preparedSpriteSheets.has(textureKey)) {
      return;
    }

    const texture = this.textures.get(textureKey);
    if (texture.frameTotal > 1) {
      this.preparedSpriteSheets.add(textureKey);
      return;
    }

    const source = texture.getSourceImage() as HTMLImageElement;
    if (!source || !source.width || !source.height) {
      return;
    }

    let columns = framesPerRow || Math.round(Math.sqrt(frameCount));
    if (columns <= 0 || frameCount % columns !== 0) {
      columns = frameCount;
    }

    const rows = Math.max(1, Math.ceil(frameCount / columns));
    const frameWidth = Math.floor(source.width / columns);
    const frameHeight = Math.floor(source.height / rows);

    this.textures.remove(textureKey);
    this.textures.addSpriteSheet(textureKey, source, {
      frameWidth,
      frameHeight,
      endFrame: frameCount - 1,
    });
    this.preparedSpriteSheets.add(textureKey);
  }

  private createLoopAnimation(key: string, texture: string, frameCount: number, frameRate: number): void {
    if (this.anims.exists(key)) {
      return;
    }

    this.anims.create({
      key,
      frames: this.anims.generateFrameNumbers(texture, { start: 0, end: frameCount - 1 }),
      frameRate,
      repeat: -1,
    });
  }

  private getSuggestedScale(textureKey: string, desiredHeightPx: number): number {
    const texture = this.textures.get(textureKey);
    const frame = texture.get(0);
    const frameHeight = Math.max(1, frame.height);
    return desiredHeightPx / frameHeight;
  }

  private emitLog(source: CommandLogEntry['source'], text: string): void {
    this.events.emit('ui-log', {
      source,
      text,
      atMs: this.time.now,
    } as CommandLogEntry);
  }

  private emitAudioCue(cue: 'bell' | 'positive' | 'negative' | 'routine_shift' | 'door'): void {
    this.events.emit('ui-audio-cue', cue);
  }

  private emitProfile(): void {
    this.events.emit('ui-profile', this.identity);
  }

  private reportOptionalAnimationFallbacks(): void {
    const fallbacks: Array<{ key: string; label: string; fallback: string }> = [
      { key: 'man-idle-stand', label: 'idle stand', fallback: 'man-walk-down' },
      { key: 'man-sit-chair', label: 'sit chair', fallback: 'man-sleep' },
      { key: 'man-use-computer', label: 'use computer', fallback: 'man-use-object' },
    ];

    fallbacks.forEach((item) => {
      if (this.missingOptionalTextures.has(item.key)) {
        this.emitLog('system', `Animation fallback active for ${item.label} (using ${item.fallback}).`);
      }
    });
  }

  private runStartupAudit(): void {
    const issues: string[] = [];
    if (this.grid.walkable.size === 0) {
      issues.push('walk masks are empty');
    }
    if (runtimeContract.doorFlow.enabled && !this.taskTargets.door) {
      issues.push('door target is missing');
    }
    if (!this.taskTargets.computerDesk) {
      issues.push('computer desk target is missing');
    }
    if (!this.taskTargets.chair) {
      issues.push('chair target is missing');
    }
    if (!this.taskTargets.runningMachine) {
      issues.push('running machine target is missing');
    }
    if (!this.taskTargets.piano) {
      issues.push('piano target is missing');
    }

    if (issues.length === 0) {
      this.emitLog('system', 'Core audit: navigation, routine targets, and command framework are ready.');
      return;
    }

    issues.forEach((issue) => {
      this.emitLog('system', `Core audit warning: ${issue}.`);
    });
  }

  private advanceDay(deltaMs: number): void {
    this.dayElapsedMs += deltaMs;

    if (!this.autoDeliveryTriggered && this.dayElapsedMs >= DAY_DURATION_MS * 0.55) {
      this.autoDeliveryTriggered = true;
      if (!this.deliveryQueued && this.isTaskAvailable('door_delivery')) {
        this.deliveryQueued = true;
        this.emitLog('system', 'A delivery arrived at the front door.');
        this.requestPriorityTask(
          { type: 'door_delivery', source: 'system', priority: INTERRUPT_PRIORITY_DOOR, resumable: false },
          'scheduled delivery'
        );
      }
    }

    if (this.dayElapsedMs >= DAY_DURATION_MS) {
      this.dayElapsedMs = 0;
      this.dayIndex += 1;
      this.autoDeliveryTriggered = false;
      this.deliveryQueued = false;
      this.lastRoutineBeatIndex = -1;
      this.interruptedTaskStack = [];
      this.emitLog('system', `Day ${this.dayIndex} begins.`);
      this.emitAudioCue('routine_shift');
      saveSnapshot({
        version: 1,
        manIdentity: this.identity,
        dayIndex: this.dayIndex,
      });
    }
  }

  private enqueueTask(task: NpcTask, toFront = false): void {
    const normalized = {
      ...task,
      source: task.source || 'system',
      priority: task.priority ?? 10,
      resumable: task.resumable ?? true,
    } satisfies NpcTask;

    if (toFront) {
      this.manTaskQueue.unshift(normalized);
      return;
    }

    const insertIndex = this.manTaskQueue.findIndex((existing) => (existing.priority ?? 0) < (normalized.priority ?? 0));
    if (insertIndex === -1) {
      this.manTaskQueue.push(normalized);
      return;
    }

    this.manTaskQueue.splice(insertIndex, 0, normalized);
  }

  private requestPriorityTask(task: NpcTask, reason: string): void {
    if (this.canInterruptNow(task.priority ?? 0)) {
      this.pauseCurrentTaskIfResumable(reason);
      this.enqueueTask(task, true);
      return;
    }

    this.enqueueTask(task, true);
  }

  private canInterruptNow(requestPriority: number): boolean {
    if (this.man.hiddenUntilMs > 0) {
      return false;
    }
    if (this.doorPhase !== 'none') {
      return false;
    }

    const activePriority = this.man.currentTask.priority ?? 0;
    return requestPriority >= activePriority;
  }

  private pauseCurrentTaskIfResumable(reason: string): boolean {
    const current = this.man.currentTask;
    if (current.type === 'idle' || current.type === 'door_delivery') {
      return false;
    }

    if (current.resumable !== false) {
      const remainingMs = this.estimateRemainingMsForCurrentTask();
      const resumableTask: NpcTask = {
        ...current,
        source: 'resume',
        priority: 40,
        remainingMs,
        resumable: false,
      };
      this.interruptedTaskStack.push(resumableTask);
      this.emitLog('system', `Task paused (${textForTask(current.type)}) due to ${reason}.`);
    } else {
      this.emitLog('system', `Task skipped (${textForTask(current.type)}) due to ${reason}.`);
    }

    this.man.currentTask = { type: 'idle', priority: 0, source: 'system' };
    this.man.performUntilMs = 0;
    this.man.pendingTargetCell = null;
    this.man.path = [];
    this.playManIdle();
    return true;
  }

  private estimateRemainingMsForCurrentTask(): number | undefined {
    const now = this.time.now;
    if (this.man.performUntilMs > now) {
      return Math.max(500, this.man.performUntilMs - now);
    }

    const task = this.man.currentTask.type;
    if (task === 'wander' || task === 'door_delivery') {
      return undefined;
    }

    return this.getTaskDuration(task);
  }

  private tryResumeInterruptedTask(): boolean {
    const next = this.interruptedTaskStack.pop();
    if (!next) {
      return false;
    }

    this.man.currentTask = {
      ...next,
      source: 'resume',
      priority: 40,
      resumable: false,
    };
    this.man.performUntilMs = 0;
    this.man.pendingTargetCell = next.targetCell ?? null;
    this.man.path = [];
    this.emitLog('system', `Resuming previous task: ${textForTask(next.type)}.`);
    return true;
  }

  private rollCommandAcceptance(intent: TaskType): boolean {
    const acceptCount = this.commandOutcomes.filter(Boolean).length;
    const rejectCount = this.commandOutcomes.length - acceptCount;

    const chance = getComplianceChance(this.identity, {
      recentAcceptRate: this.commandOutcomes.length === 0 ? 0.5 : acceptCount / this.commandOutcomes.length,
      recentRejectRate: this.commandOutcomes.length === 0 ? 0 : rejectCount / this.commandOutcomes.length,
      ringBellCount: this.ringBellCount,
    });

    const isPlayfulTask = intent === 'dance' || intent === 'pet_dog';
    const taskBias = isPlayfulTask ? this.identity.personality.playfulness * 0.2 : this.identity.personality.diligence * 0.15;
    return Math.random() < clamp(chance + taskBias, 0.08, 0.95);
  }

  private recordCommandOutcome(accepted: boolean): void {
    this.commandOutcomes.push(accepted);
    if (this.commandOutcomes.length > 10) {
      this.commandOutcomes.shift();
    }
  }

  private tickMan(deltaMs: number, time: number): void {
    if (this.man.hiddenUntilMs > 0 && time >= this.man.hiddenUntilMs) {
      this.man.hiddenUntilMs = 0;
      this.man.sprite.setVisible(true);
      this.emitLog('man', `${this.identity.name} came back inside.`);
      this.doorPhase = 'returning';
      this.man.performUntilMs = time + 700;
      this.man.currentTask = { type: 'door_delivery', source: 'system', priority: INTERRUPT_PRIORITY_DOOR, resumable: false };
    }

    if (this.man.hiddenUntilMs > 0) {
      return;
    }

    if (this.doorPhase !== 'none') {
      this.handleDoorFlow(time);
      return;
    }

    if (this.man.currentTask.type === 'idle' && this.manTaskQueue.length > 0) {
      this.man.currentTask = this.manTaskQueue.shift() as NpcTask;
      this.man.performUntilMs = 0;
      this.man.pendingTargetCell = null;
    }

    if (this.man.currentTask.type === 'idle' && this.manTaskQueue.length === 0 && this.interruptedTaskStack.length > 0) {
      this.tryResumeInterruptedTask();
    }

    if (this.man.currentTask.type === 'idle' && this.manTaskQueue.length === 0 && this.interruptedTaskStack.length === 0) {
      this.pickRoutineTask(time);
    }

    if (this.man.currentTask.type === 'door_delivery') {
      this.startDoorFlow();
      return;
    }

    this.runTask(this.man, time, deltaMs);
  }

  private startDoorFlow(): void {
    this.doorPhase = 'to_door';
    this.deliveryQueued = false;
    this.man.path = [];
    this.man.pendingTargetCell = this.taskTargets.door;
  }

  private handleDoorFlow(time: number): void {
    if (!this.taskTargets.door) {
      this.finishManTask();
      this.doorPhase = 'none';
      return;
    }

    if (this.doorPhase === 'to_door') {
      const reachedDoor = this.moveNpcToCell(this.man, this.taskTargets.door, time);
      if (reachedDoor) {
        this.doorPhase = 'opening';
        this.man.performUntilMs = time + 900;
        this.man.sprite.play('man-anim-use-object', true);
      }
      return;
    }

    if (this.doorPhase === 'opening') {
      if (time >= this.man.performUntilMs) {
        this.doorPhase = 'outside';
        this.man.hiddenUntilMs = time + runtimeContract.doorFlow.outsideDurationMs;
        this.man.sprite.setVisible(false);
        this.emitLog('man', `${this.identity.name} stepped outside for a delivery.`);
        this.emitAudioCue('door');
      }
      return;
    }

    if (this.doorPhase === 'returning') {
      this.playManIdle();
      if (time >= this.man.performUntilMs) {
        this.doorPhase = 'none';
        this.finishManTask();
      }
    }
  }

  private runTask(npc: NpcRuntime, time: number, deltaMs: number): void {
    const task = npc.currentTask.type;

    if (task === 'idle' || task === 'idle_stand') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        npc.sprite.play('man-anim-idle-stand', true);
      }
      if (time >= npc.performUntilMs) {
        this.finishManTask();
      }
      return;
    }

    if (task === 'wander') {
      if (!npc.pendingTargetCell) {
        npc.pendingTargetCell = pickRandomWalkableCell(this.grid);
      }
      const done = this.moveNpcToCell(npc, npc.pendingTargetCell, time);
      if (done) {
        this.finishManTask();
      }
      return;
    }

    if (task === 'sleep') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        npc.sprite.play('man-anim-sleep', true);
      }
      if (time >= npc.performUntilMs) {
        this.finishManTask();
      }
      return;
    }

    if (task === 'pet_dog') {
      const target = this.getTargetForTask(task);
      if (!target) {
        this.finishManTask();
        return;
      }

      const atTarget = this.moveNpcToCell(npc, target, time);
      if (!atTarget) {
        return;
      }

      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        npc.sprite.play('man-anim-idle-stand', true);
        this.pauseCurrentAnimation(npc.sprite);
        this.dog.path = [];
        this.playDogIdle();
        this.emitLog('man', `${this.identity.name} spends a moment with the dog.`);
      }

      if (time >= npc.performUntilMs) {
        this.dogInteractionCooldownUntilMs = time + 45_000;
        this.finishManTask();
      }
      return;
    }

    const target = this.getTargetForTask(task);
    if (!target) {
      this.finishManTask();
      return;
    }

    const atTarget = this.moveNpcToCell(npc, target, time);
    if (!atTarget) {
      return;
    }

    if (npc.performUntilMs === 0) {
      npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
      if (task === 'dance') {
        npc.sprite.play('man-anim-walk-right', true);
      } else if (task === 'sit_chair') {
        npc.sprite.play('man-anim-sit-chair', true);
      } else if (task === 'use_computer') {
        npc.sprite.play('man-anim-use-computer', true);
      } else if (task === 'use_running_machine' || task === 'play_piano' || task === 'type_letter' || task === 'play_another_song') {
        npc.sprite.play('man-anim-use-object', true);
      }
      return;
    }

    if (time >= npc.performUntilMs) {
      this.finishManTask();
    } else {
      // Keep subtle frame progression with animated clips.
      npc.sprite.anims.timeScale = 1 + deltaMs * 0.0001;
    }
  }

  private getTaskDuration(task: TaskType): number {
    switch (task) {
      case 'idle':
      case 'idle_stand':
        return 7_000;
      case 'pet_dog':
        return 6_500;
      case 'sit_chair':
        return 9_500;
      case 'use_computer':
        return 11_000;
      case 'type_letter':
        return 12_000;
      case 'use_running_machine':
        return 10_000;
      case 'play_piano':
        return 12_000;
      case 'play_another_song':
        return 9_000;
      case 'dance':
        return 7_000;
      default:
        return 6_000;
    }
  }

  private resolveTaskDuration(task: NpcTask): number {
    if (task.remainingMs && task.remainingMs > 200) {
      const duration = task.remainingMs;
      task.remainingMs = undefined;
      return duration;
    }

    return this.getTaskDuration(task.type);
  }

  private getTargetForTask(task: TaskType): CellKey | null {
    switch (task) {
      case 'pet_dog':
        return this.getDogInteractionCell();
      case 'sit_chair':
        return this.taskTargets.chair;
      case 'use_computer':
        return this.taskTargets.computerDesk || this.taskTargets.letterDesk;
      case 'use_running_machine':
        return this.taskTargets.runningMachine;
      case 'play_piano':
      case 'play_another_song':
        return this.taskTargets.piano;
      case 'type_letter':
        return this.taskTargets.letterDesk;
      default:
        return null;
    }
  }

  private getDogInteractionCell(): CellKey | null {
    const dogCell = worldToCell({ x: this.dog.sprite.x, y: this.dog.sprite.y }, runtimeContract.gridSize);
    const [colRaw, rowRaw] = dogCell.split(',');
    const baseCol = Number(colRaw);
    const baseRow = Number(rowRaw);

    const candidates: CellKey[] = [
      `${baseCol - 1},${baseRow}` as CellKey,
      `${baseCol + 1},${baseRow}` as CellKey,
      `${baseCol},${baseRow - 1}` as CellKey,
      `${baseCol},${baseRow + 1}` as CellKey,
      dogCell,
    ];

    for (const candidate of candidates) {
      if (this.grid.walkable.has(candidate)) {
        return candidate;
      }
    }

    return findNearestWalkableCell(this.grid, dogCell);
  }

  private taskNeedsTarget(task: TaskType): boolean {
    return (
      task === 'pet_dog' ||
      task === 'sit_chair' ||
      task === 'use_computer' ||
      task === 'use_running_machine' ||
      task === 'play_piano' ||
      task === 'play_another_song' ||
      task === 'type_letter' ||
      task === 'door_delivery'
    );
  }

  private isTaskAvailable(task: TaskType): boolean {
    if (!this.taskNeedsTarget(task)) {
      return true;
    }
    if (task === 'door_delivery') {
      return Boolean(this.taskTargets.door);
    }
    return this.getTargetForTask(task) !== null;
  }

  private resolveTaskWithAvailability(task: TaskType): TaskType {
    if (this.isTaskAvailable(task)) {
      return task;
    }

    const fallbackTasks: TaskType[] = ['idle_stand', 'pet_dog', 'wander', 'type_letter', 'play_piano', 'sleep', 'idle'];
    for (const candidate of fallbackTasks) {
      if (this.isTaskAvailable(candidate)) {
        return candidate;
      }
    }

    return 'idle';
  }

  private finishManTask(): void {
    this.man.currentTask = { type: 'idle', source: 'system', priority: 0, resumable: false };
    this.man.performUntilMs = 0;
    this.man.pendingTargetCell = null;
    this.man.path = [];
    this.playManIdle();
  }

  private moveNpcToCell(npc: NpcRuntime, targetCell: CellKey, time: number): boolean {
    if (npc.path.length === 0 || npc.pendingTargetCell !== targetCell) {
      this.rebuildPathForNpc(npc, targetCell);
    }

    if (npc.path.length === 0) {
      return this.isNpcAtCell(npc, targetCell);
    }

    const nextCell = npc.path[0];
    const nextPoint = cellToWorldCenter(nextCell, runtimeContract.gridSize);
    const dx = nextPoint.x - npc.sprite.x;
    const dy = nextPoint.y - npc.sprite.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= 1.4) {
      npc.sprite.setPosition(nextPoint.x, nextPoint.y);
      npc.path.shift();
      if (npc.path.length === 0) {
        this.playNpcIdle(npc);
        return true;
      }
      return false;
    }

    const step = (npc.moveSpeed / 1000) * this.game.loop.delta;
    npc.sprite.setPosition(npc.sprite.x + (dx / distance) * step, npc.sprite.y + (dy / distance) * step);

    const direction = getDirection(dx, dy);
    this.playWalkAnimation(npc, direction, time);

    return false;
  }

  private isNpcAtCell(npc: NpcRuntime, cell: CellKey): boolean {
    const current = worldToCell({ x: npc.sprite.x, y: npc.sprite.y }, runtimeContract.gridSize);
    return current === cell;
  }

  private rebuildPathForNpc(npc: NpcRuntime, targetCell: CellKey): void {
    const currentCell = worldToCell({ x: npc.sprite.x, y: npc.sprite.y }, runtimeContract.gridSize);
    const start = findNearestWalkableCell(this.grid, currentCell) || targetCell;
    const goal = findNearestWalkableCell(this.grid, targetCell) || targetCell;

    const nextPath = findPathBfs(this.grid, start, goal);
    npc.path = nextPath.slice(1);
    npc.pendingTargetCell = targetCell;
  }

  private playWalkAnimation(npc: NpcRuntime, direction: 'left' | 'right' | 'up' | 'down', time: number): void {
    if (npc.id === 'man') {
      const key =
        direction === 'left'
          ? 'man-anim-walk-left'
          : direction === 'right'
            ? 'man-anim-walk-right'
            : direction === 'up'
              ? 'man-anim-walk-up'
              : 'man-anim-walk-down';
      npc.sprite.play(key, true);
      return;
    }

    const dogKey =
      direction === 'left'
        ? 'dog-anim-walk-left'
        : direction === 'right'
          ? 'dog-anim-walk-right'
          : direction === 'up'
            ? 'dog-anim-walk-up'
            : 'dog-anim-walk-down';
    npc.sprite.play(dogKey, true);

    if (time % 8000 < 16) {
      npc.sprite.anims.timeScale = 1;
    }
  }

  private playManIdle(): void {
    this.man.sprite.play('man-anim-idle-stand', true);
    this.pauseCurrentAnimation(this.man.sprite);
  }

  private playDogIdle(): void {
    this.dog.sprite.play('dog-anim-walk-down', true);
    this.pauseCurrentAnimation(this.dog.sprite);
  }

  private playNpcIdle(npc: NpcRuntime): void {
    if (npc.id === 'man') {
      this.playManIdle();
    } else {
      this.playDogIdle();
    }
  }

  private pickRoutineTask(time: number): void {
    const dayRatio = this.dayElapsedMs / DAY_DURATION_MS;
    const beatIndex = this.routineBeats.findIndex((beat) => dayRatio >= beat.startRatio && dayRatio < beat.endRatio);
    const beat = this.routineBeats[Math.max(0, beatIndex)];
    const beatChanged = beatIndex !== this.lastRoutineBeatIndex;

    if (beatChanged) {
      this.lastRoutineBeatIndex = beatIndex;
      this.emitLog('system', `Routine shift: ${beat.label}.`);
      this.emitAudioCue('routine_shift');
    }

    let task: TaskType = beat.task;
    const beatRoll = this.getDeterministicBeatRoll(beatIndex, 1);

    if (task === 'play_piano' && this.identity.personality.playfulness > 0.66 && beatRoll < 0.33) {
      task = 'dance';
    } else if (task === 'use_computer' && this.identity.personality.diligence > 0.7 && beatRoll < 0.35) {
      task = 'type_letter';
    } else if (task === 'wander') {
      const canPetDog = time >= this.dogInteractionCooldownUntilMs && this.isTaskAvailable('pet_dog');
      task = weightedChoiceByRoll<TaskType>(
        [
          { value: 'idle_stand', weight: 14 },
          { value: 'wander', weight: 12 },
          { value: 'sit_chair', weight: 7 },
          { value: 'play_piano', weight: this.identity.personality.playfulness * 10 + 2 },
          { value: 'pet_dog', weight: canPetDog ? 8 : 0 },
        ],
        this.getDeterministicBeatRoll(beatIndex, 3)
      );
    }

    const resolvedTask = this.resolveTaskWithAvailability(task);
    if (resolvedTask !== task && beatChanged) {
      this.emitLog('system', `Routine fallback: ${textForTask(task)} unavailable, using ${textForTask(resolvedTask)}.`);
    }

    this.man.currentTask = { type: resolvedTask, source: 'routine', priority: 10, resumable: true };
    this.man.performUntilMs = 0;
  }

  private getDeterministicBeatRoll(beatIndex: number, salt: number): number {
    const normalizedBeat = Math.max(0, beatIndex);
    const seed = this.identity.appearanceSeed + this.dayIndex * 101 + normalizedBeat * 37 + salt * 13;
    const x = Math.sin(seed * 0.0009) * 10000;
    return x - Math.floor(x);
  }

  private tickDog(_deltaMs: number, time: number): void {
    if (this.man.currentTask.type === 'pet_dog') {
      const target = this.getDogCompanionCellNearMan();
      if (target) {
        const reached = this.moveNpcToCell(this.dog, target, time);
        if (reached) {
          this.playDogIdle();
        }
      } else {
        this.playDogIdle();
      }
      return;
    }

    const dayRatio = this.dayElapsedMs / DAY_DURATION_MS;

    if (dayRatio > 0.9) {
      this.dog.currentTask = { type: 'sleep' };
      this.dog.path = [];
      this.dog.sprite.play('dog-anim-walk-down', true);
      this.pauseCurrentAnimation(this.dog.sprite);
      return;
    }

    if (this.dog.currentTask.type === 'sleep') {
      this.dog.currentTask = { type: 'wander' };
    }

    if (this.dog.path.length === 0) {
      const manCell = worldToCell({ x: this.man.sprite.x, y: this.man.sprite.y }, runtimeContract.gridSize);
      const followBias = Math.random() < 0.6;

      if (followBias) {
        const offsets = [
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
          [3, 1],
          [-3, -1],
        ];

        const [colRaw, rowRaw] = manCell.split(',');
        const baseCol = Number(colRaw);
        const baseRow = Number(rowRaw);
        for (const [dx, dy] of offsets) {
          const candidate = `${baseCol + dx},${baseRow + dy}` as CellKey;
          if (this.grid.walkable.has(candidate)) {
            this.rebuildPathForNpc(this.dog, candidate);
            break;
          }
        }
      }

      if (this.dog.path.length === 0) {
        this.rebuildPathForNpc(this.dog, pickRandomWalkableCell(this.grid));
      }
    }

    if (this.dog.path.length > 0) {
      const nextCell = this.dog.path[0];
      const nextPoint = cellToWorldCenter(nextCell, runtimeContract.gridSize);
      const dx = nextPoint.x - this.dog.sprite.x;
      const dy = nextPoint.y - this.dog.sprite.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= 1.5) {
        this.dog.sprite.setPosition(nextPoint.x, nextPoint.y);
        this.dog.path.shift();
        if (this.dog.path.length === 0) {
          this.playDogIdle();
        }
      } else {
        const step = (this.dog.moveSpeed / 1000) * this.game.loop.delta;
        this.dog.sprite.setPosition(this.dog.sprite.x + (dx / distance) * step, this.dog.sprite.y + (dy / distance) * step);
        this.playWalkAnimation(this.dog, getDirection(dx, dy), time);
      }
    }
  }

  private pauseCurrentAnimation(sprite: Phaser.GameObjects.Sprite): void {
    sprite.anims.pause(sprite.anims.currentFrame ?? undefined);
  }

  private getDogCompanionCellNearMan(): CellKey | null {
    const manCell = worldToCell({ x: this.man.sprite.x, y: this.man.sprite.y }, runtimeContract.gridSize);
    const [colRaw, rowRaw] = manCell.split(',');
    const col = Number(colRaw);
    const row = Number(rowRaw);
    const candidates: CellKey[] = [
      `${col + 1},${row}` as CellKey,
      `${col - 1},${row}` as CellKey,
      `${col},${row + 1}` as CellKey,
      `${col},${row - 1}` as CellKey,
      manCell,
    ];

    for (const candidate of candidates) {
      if (this.grid.walkable.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private applyOcclusionVisibility(npc: NpcRuntime): void {
    if (npc.id === 'man' && npc.hiddenUntilMs > 0) {
      npc.sprite.setVisible(false);
      return;
    }

    const zones = runtimeContract.occlusion.zones as readonly OcclusionZone[];
    const hidden = zones.some((zone) => {
      if (zone.mode === 'show') {
        return false;
      }

      return (
        npc.sprite.x >= zone.x &&
        npc.sprite.x <= zone.x + zone.width &&
        npc.sprite.y >= zone.y &&
        npc.sprite.y <= zone.y + zone.height
      );
    });

    npc.sprite.setVisible(!hidden);
  }
}
