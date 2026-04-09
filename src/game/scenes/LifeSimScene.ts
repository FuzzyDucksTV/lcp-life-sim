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
  texture: string;
  frameCount: number;
  framesPerRow?: number;
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

function weightedChoice<T>(options: Array<{ value: T; weight: number }>): T {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let target = Math.random() * total;

  for (const option of options) {
    target -= option.weight;
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
  private commandOutcomes: boolean[] = [];
  private dayIndex = 1;
  private dayElapsedMs = 0;
  private autoDeliveryTriggered = false;
  private deliveryQueued = false;
  private ringBellCount = 0;
  private lastProfilePushAt = 0;
  private lastRoutineBeatIndex = -1;
  private doorPhase: 'none' | 'to_door' | 'opening' | 'outside' | 'returning' = 'none';

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

  private readonly animationSpecs: Record<string, AnimationSpec> = {
    manWalkDown: { texture: 'man-walk-down', frameCount: 16, framesPerRow: 4 },
    manWalkUp: { texture: 'man-walk-up', frameCount: 16, framesPerRow: 4 },
    manWalkLeft: { texture: 'man-walk-left', frameCount: 16, framesPerRow: 4 },
    manWalkRight: { texture: 'man-walk-right', frameCount: 16, framesPerRow: 4 },
    manSleep: { texture: 'man-sleep', frameCount: 16, framesPerRow: 4 },
    manUseObject: { texture: 'man-use-object', frameCount: 36, framesPerRow: 6 },
    dogWalkDown: { texture: 'dog-walk-down', frameCount: 16, framesPerRow: 4 },
    dogWalkUp: { texture: 'dog-walk-up', frameCount: 16, framesPerRow: 4 },
    dogWalkLeft: { texture: 'dog-walk-left', frameCount: 16, framesPerRow: 4 },
    dogWalkRight: { texture: 'dog-walk-right', frameCount: 16, framesPerRow: 4 },
  };

  constructor() {
    super('LifeSimScene');
  }

  preload(): void {
    this.load.image('background', '/background/house-background.png');

    this.load.image('man-walk-down', '/sprites/man-walking-down.png');
    this.load.image('man-walk-up', '/sprites/man-walking-up.png');
    this.load.image('man-walk-left', '/sprites/man-walking-left.png');
    this.load.image('man-walk-right', '/sprites/man-walking-right.png');
    this.load.image('man-sleep', '/sprites/man-sleeping.png');
    this.load.image('man-use-object', '/sprites/man-using-object.png');

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
      currentTask: { type: 'idle' },
      performUntilMs: 0,
      moveSpeed: MAN_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.dog = {
      id: 'dog',
      sprite: this.add.sprite(dogSpawn.x, dogSpawn.y, 'dog-walk-down', 0).setScale(dogScale),
      path: [],
      currentTask: { type: 'wander' },
      performUntilMs: 0,
      moveSpeed: DOG_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.playManIdle();
    this.playDogIdle();

    this.emitLog('system', `${this.identity.name} moved in. Personality locked for this life.`);
    this.emitLog('system', 'Simulation hidden mode enabled. Use Ring Bell or polite commands.');
    this.emitLog('system', 'Phase 6.1 routine enabled: idle stand, sit chair, and computer use are active.');
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
    if (this.deliveryQueued || this.doorPhase !== 'none' || this.man.currentTask.type === 'door_delivery') {
      this.emitLog('system', 'The bell rings, but a delivery is already in progress.');
      this.emitAudioCue('negative');
      return;
    }

    this.deliveryQueued = true;
    this.emitLog('player', 'Please come to the door.');
    this.emitLog('man', `${this.identity.name} heard the bell and will check the door.`);
    this.emitAudioCue('bell');
    this.enqueueTask({ type: 'door_delivery' }, true);
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

    this.enqueueTask({
      type: command.intent,
      fromPlayerCommand: command.normalized,
    });
    this.emitLog('man', `Okay, I will ${textForTask(command.intent)}.`);
    this.recordCommandOutcome(true);
    this.identity.mood = onCommandAccepted(this.identity.mood);
    this.emitAudioCue('positive');
    this.emitProfile();
  }

  private prepareAllAnimations(): void {
    Object.values(this.animationSpecs).forEach((spec) => {
      this.prepareSpriteSheet(spec.texture, spec.frameCount, spec.framesPerRow);
    });

    this.createLoopAnimation('man-anim-walk-down', 'man-walk-down', 16, 10);
    this.createLoopAnimation('man-anim-walk-up', 'man-walk-up', 16, 10);
    this.createLoopAnimation('man-anim-walk-left', 'man-walk-left', 16, 10);
    this.createLoopAnimation('man-anim-walk-right', 'man-walk-right', 16, 10);
    this.createLoopAnimation('man-anim-idle-stand', 'man-walk-down', 16, 4);
    this.createLoopAnimation('man-anim-sit-chair', 'man-sleep', 16, 5);
    this.createLoopAnimation('man-anim-use-computer', 'man-use-object', 36, 9);
    this.createLoopAnimation('man-anim-sleep', 'man-sleep', 16, 6);
    this.createLoopAnimation('man-anim-use-object', 'man-use-object', 36, 14);

    this.createLoopAnimation('dog-anim-walk-down', 'dog-walk-down', 16, 12);
    this.createLoopAnimation('dog-anim-walk-up', 'dog-walk-up', 16, 12);
    this.createLoopAnimation('dog-anim-walk-left', 'dog-walk-left', 16, 12);
    this.createLoopAnimation('dog-anim-walk-right', 'dog-walk-right', 16, 12);
  }

  private prepareSpriteSheet(textureKey: string, frameCount: number, framesPerRow?: number): void {
    const texture = this.textures.get(textureKey);
    const source = texture.getSourceImage() as HTMLImageElement;

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

  private advanceDay(deltaMs: number): void {
    this.dayElapsedMs += deltaMs;

    if (!this.autoDeliveryTriggered && this.dayElapsedMs >= DAY_DURATION_MS * 0.55) {
      this.autoDeliveryTriggered = true;
      if (!this.deliveryQueued) {
        this.deliveryQueued = true;
        this.emitLog('system', 'A delivery arrived at the front door.');
        this.enqueueTask({ type: 'door_delivery' }, true);
      }
    }

    if (this.dayElapsedMs >= DAY_DURATION_MS) {
      this.dayElapsedMs = 0;
      this.dayIndex += 1;
      this.autoDeliveryTriggered = false;
      this.deliveryQueued = false;
      this.lastRoutineBeatIndex = -1;
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
    if (toFront) {
      this.manTaskQueue.unshift(task);
      return;
    }

    this.manTaskQueue.push(task);
  }

  private rollCommandAcceptance(intent: TaskType): boolean {
    const acceptCount = this.commandOutcomes.filter(Boolean).length;
    const rejectCount = this.commandOutcomes.length - acceptCount;

    const chance = getComplianceChance(this.identity, {
      recentAcceptRate: this.commandOutcomes.length === 0 ? 0.5 : acceptCount / this.commandOutcomes.length,
      recentRejectRate: this.commandOutcomes.length === 0 ? 0 : rejectCount / this.commandOutcomes.length,
      ringBellCount: this.ringBellCount,
    });

    const taskBias = intent === 'dance' ? this.identity.personality.playfulness * 0.2 : this.identity.personality.diligence * 0.15;
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
      this.man.currentTask = { type: 'door_delivery' };
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

    if (this.man.currentTask.type === 'idle' && this.manTaskQueue.length === 0) {
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
        npc.performUntilMs = time + this.getTaskDuration(task);
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
        npc.performUntilMs = time + 16_000;
        npc.sprite.play('man-anim-sleep', true);
      }
      if (time >= npc.performUntilMs) {
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
      npc.performUntilMs = time + this.getTaskDuration(task);
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

  private getTargetForTask(task: TaskType): CellKey | null {
    switch (task) {
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

  private finishManTask(): void {
    this.man.currentTask = { type: 'idle' };
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

  private pickRoutineTask(_time: number): void {
    const dayRatio = this.dayElapsedMs / DAY_DURATION_MS;
    const beatIndex = this.routineBeats.findIndex((beat) => dayRatio >= beat.startRatio && dayRatio < beat.endRatio);
    const beat = this.routineBeats[Math.max(0, beatIndex)];

    if (beatIndex !== this.lastRoutineBeatIndex) {
      this.lastRoutineBeatIndex = beatIndex;
      this.emitLog('system', `Routine shift: ${beat.label}.`);
      this.emitAudioCue('routine_shift');
    }

    let task: TaskType = beat.task;

    if (task === 'play_piano' && this.identity.personality.playfulness > 0.66 && Math.random() < 0.33) {
      task = 'dance';
    } else if (task === 'use_computer' && this.identity.personality.diligence > 0.7 && Math.random() < 0.35) {
      task = 'type_letter';
    } else if (task === 'wander' && Math.random() < 0.5) {
      task = weightedChoice<TaskType>([
        { value: 'idle_stand', weight: 14 },
        { value: 'wander', weight: 12 },
        { value: 'sit_chair', weight: 7 },
        { value: 'play_piano', weight: this.identity.personality.playfulness * 12 + 2 },
      ]);
    }

    this.man.currentTask = { type: task };
    this.man.performUntilMs = 0;
  }

  private tickDog(_deltaMs: number, time: number): void {
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
