import Phaser from 'phaser';
import houseLayout from '../../data/houseLayout.json';
import { parsePlayerCommand } from '../sim/commandParser';
import {
  runtimeContract,
  getLayoutObjectAnchor,
  getLayoutToWorldScale,
  getWorldSizeFromContract,
  resolveTaskTargetCells,
} from '../sim/contract';
import {
  createNavigationGrid,
  findNearestWalkableCell,
  findPathBfs,
  cellToWorldCenter,
  parseCellKey,
  pickRandomWalkableCell,
  toCellKey,
  worldToCell,
  type NavigationGrid,
} from '../sim/navigation';
import { loadOrCreateIdentity, loadSnapshot, saveSnapshot } from '../sim/saveState';
import { getComplianceChance, onCommandAccepted, onCommandRejected, tickMood } from '../sim/mood';
import type { CellKey, CommandLogEntry, ManIdentity, NpcTask, TaskType } from '../types';

const DAY_DURATION_MS = 60 * 60 * 1000;
const PROFILE_REFRESH_INTERVAL_MS = 2_000;
const MAN_MOVE_SPEED = 74;
const DOG_MOVE_SPEED = 86;
const INTERRUPT_PRIORITY_PLAYER = 80;
const INTERRUPT_PRIORITY_DOOR = 100;
const MAX_PENDING_PLAYER_REQUESTS = 3;
const LETTER_REPLY_DELAY_MS = 2_200;
const QUEUE_FOLLOWUP_DELAY_MS = 1_600;
const DAILY_REFLECTION_DELAY_MS = 2_400;
const FAST_COMMAND_WINDOW_MS = 2_600;
const DUPLICATE_REQUEST_WINDOW_MS = 9_000;
const MAN_RENDER_Y_OFFSET = -54;
const DOG_RENDER_Y_OFFSET = -20;
const MAN_DESIRED_HEIGHT_PX = 172;
const DOG_DESIRED_HEIGHT_PX = 90;
const MAN_REACTION_ACK_MS = 2_000;
const MAN_REACTION_REJECT_MS = 2_000;
const MAN_REACTION_BELL_MS = 2_000;
const MAN_REACTION_KNOCK_MS = 2_400;
const ATTENTION_IDLE_THRESHOLD_MS = 2 * 60 * 1000;
const ATTENTION_KNOCK_INTERVAL_MIN_MS = 90 * 1000;
const ATTENTION_KNOCK_INTERVAL_MAX_MS = 180 * 1000;
const STARTUP_EXPLORATION_DELAY_MS = 3_000;
const STARTUP_EXPLORATION_PRIORITY = 35;
const LAYOUT_OBJECT_DEPTH_Z_MULTIPLIER = 64;
const LAYOUT_OBJECT_TEXTURE_PREFIX = 'layout-object-';
const MAN_INTERACTION_DEPTH_BOOST = 50_000;
const DOG_SLEEP_DURATION_MIN_MS = 120_000;
const DOG_SLEEP_DURATION_MAX_MS = 240_000;
const DOG_EAT_DURATION_MS = 20_000;
const DOG_SLEEP_CHANCE = 0.12;
const DOG_EAT_CHANCE = 0.08;
const WASHING_COLLECT_DELAY_MIN_MS = 300_000;
const WASHING_COLLECT_DELAY_MAX_MS = 600_000;
const FORGET_CHANCE = 0.35;

const INTERACTIVE_OBJECT_TYPES: ReadonlyMap<string, { task: TaskType; hideOnStart: boolean }> = new Map([
  ['cooker_3x4_cooking', { task: 'use_cooker', hideOnStart: false }],
  ['cupboard_2x1_open', { task: 'open_kitchen_cupboard', hideOnStart: false }],
  ['dishwasher_3x4_open', { task: 'use_dishwasher', hideOnStart: false }],
  ['fridge_6x6_open', { task: 'use_fridge', hideOnStart: false }],
  ['wardrobe_5_5x6_idle', { task: 'use_wardrobe', hideOnStart: false }],
  ['washingmachine_3x4_full', { task: 'use_washing_machine', hideOnStart: false }],
]);
const ACTION_ANCHOR_KEYS = [
  'sit_sofa',
  'sit_settee',
  'sit_computer_desk',
  'sit_piano',
  'lay_bed',
  'take_shower',
  'use_toilet',
  'use_fridge',
  'use_kitchen_sink',
  'use_washing_machine',
  'use_dishwasher',
  'open_kitchen_cupboard',
  'use_bookcase',
  'use_running_machine',
  'use_kitchen_worktop',
  'use_cooker',
  'use_wardrobe',
  'dog_eating',
  'dog_sleeping',
] as const;

type ActionAnchorKey = (typeof ACTION_ANCHOR_KEYS)[number];

const TASK_ACTION_ANCHOR_KEYS: Partial<Record<TaskType, readonly ActionAnchorKey[]>> = {
  sit_chair: ['sit_sofa', 'sit_settee'],
  sit_sofa: ['sit_sofa'],
  sit_settee: ['sit_settee'],
  sit_computer_desk: ['sit_computer_desk'],
  sit_piano: ['sit_piano'],
  lay_bed: ['lay_bed'],
  take_shower: ['take_shower'],
  use_toilet: ['use_toilet'],
  use_fridge: ['use_fridge'],
  use_kitchen_sink: ['use_kitchen_sink'],
  use_washing_machine: ['use_washing_machine'],
  use_dishwasher: ['use_dishwasher'],
  open_kitchen_cupboard: ['open_kitchen_cupboard'],
  use_bookcase: ['use_bookcase'],
  use_computer: ['sit_computer_desk'],
  type_letter: ['sit_computer_desk'],
  play_piano: ['sit_piano'],
  play_another_song: ['sit_piano'],
  use_running_machine: ['use_running_machine'],
  use_kitchen_worktop: ['use_kitchen_worktop'],
  use_cooker: ['use_cooker'],
  use_wardrobe: ['use_wardrobe'],
  collect_washing: ['use_washing_machine'],
};

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

interface PlayerRequestEnvelope {
  id: number;
  raw: string;
  normalized: string;
  intent: TaskType;
  enqueuedAtMs: number;
  resolveAtMs: number;
  queueDepthAtEnqueue: number;
  repeatStreak: number;
  cadencePenalty: number;
}

interface DelayedNarrativeEvent {
  id: number;
  atMs: number;
  type: 'letter_reply' | 'queue_followup' | 'daily_reflection';
  message?: string;
}

interface LayoutPlacedObject {
  id: string;
  type: string;
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  zIndex?: number;
}

interface ActionAnchorPoint {
  x: number;
  y: number;
  foreground: boolean;
}

function layoutObjectTextureKey(type: string): string {
  return `${LAYOUT_OBJECT_TEXTURE_PREFIX}${type}`;
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
    case 'sit_sofa':
      return 'sit on the sofa';
    case 'sit_settee':
      return 'sit on the settee';
    case 'sit_computer_desk':
      return 'sit at the computer desk';
    case 'sit_piano':
      return 'sit at the piano';
    case 'lay_bed':
      return 'lay in bed';
    case 'take_shower':
      return 'take a shower';
    case 'use_toilet':
      return 'use the toilet';
    case 'use_fridge':
      return 'use the fridge';
    case 'use_kitchen_sink':
      return 'use the kitchen sink';
    case 'use_washing_machine':
      return 'use the washing machine';
    case 'use_dishwasher':
      return 'use the dishwasher';
    case 'open_kitchen_cupboard':
      return 'open a kitchen cupboard';
    case 'use_bookcase':
      return 'use the bookcase';
    case 'use_kitchen_worktop':
      return 'use the kitchen worktop';
    case 'use_cooker':
      return 'use the cooker';
    case 'use_wardrobe':
      return 'use the wardrobe';
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
    case 'eating_food':
      return 'eat some food';
    case 'collect_washing':
      return 'collect the washing';
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
  private actionAnchors: Partial<Record<ActionAnchorKey, ActionAnchorPoint>> = {};
  private manTaskQueue: NpcTask[] = [];
  private interruptedTaskStack: NpcTask[] = [];
  private playerRequests: PlayerRequestEnvelope[] = [];
  private delayedNarrativeEvents: DelayedNarrativeEvent[] = [];
  private commandOutcomes: boolean[] = [];
  private requestSequence = 0;
  private delayedEventSequence = 0;
  private lastRequestedIntent: TaskType | null = null;
  private sameIntentStreak = 0;
  private lastRequestAtMs = 0;
  private dailyAcceptedCount = 0;
  private dailyRejectedCount = 0;
  private dayIndex = 1;
  private dayElapsedMs = 0;
  private autoDeliveryTriggered = false;
  private deliveryQueued = false;
  private ringBellCount = 0;
  private lastProfilePushAt = 0;
  private lastRoutineBeatIndex = -1;
  private dogInteractionCooldownUntilMs = 0;
  private dogActivityCooldownUntilMs = 0;
  private startupExplorationQueued = false;
  private startupExplorationDueAtMs = STARTUP_EXPLORATION_DELAY_MS;
  private doorPhase: 'none' | 'to_door' | 'opening' | 'outside' | 'returning' = 'none';
  private manReactionUntilMs = 0;
  private lastPlayerInteractionAtMs = 0;
  private nextAttentionKnockAtMs = 0;
  private attentionReasonCursor = 0;
  private preparedSpriteSheets = new Set<string>();
  private missingOptionalTextures = new Set<string>();
  private missingLayoutTextureKeys = new Set<string>();
  private interactiveObjectSprites = new Map<string, Phaser.GameObjects.Image>();
  private washingCollectDueAtMs = 0;

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
      texture: 'man-sit-forward',
      fallbackTexture: 'man-sit-chair',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 5,
    },
    {
      animationKey: 'man-anim-use-computer',
      texture: 'man-sit-away',
      fallbackTexture: 'man-use-computer',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 9,
    },
    {
      animationKey: 'man-anim-nod',
      texture: 'man-nod',
      fallbackTexture: 'man-idle-stand',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 9,
    },
    {
      animationKey: 'man-anim-shake',
      texture: 'man-shake',
      fallbackTexture: 'man-idle-stand',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 9,
    },
    { animationKey: 'man-anim-sleep', texture: 'man-sleep', frameCount: 16, framesPerRow: 4, frameRate: 6 },
    {
      animationKey: 'man-anim-dance',
      texture: 'man-dance',
      fallbackTexture: 'man-use-object',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 14,
    },
    {
      animationKey: 'man-anim-knock',
      texture: 'man-knock',
      fallbackTexture: 'man-use-object',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 14,
    },
    {
      animationKey: 'man-anim-running-machine',
      texture: 'man-running-machine',
      fallbackTexture: 'man-use-object',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 14,
    },
    { animationKey: 'man-anim-use-object', texture: 'man-use-object', frameCount: 36, framesPerRow: 6, frameRate: 14 },
    {
      animationKey: 'man-anim-eating-food',
      texture: 'man-eating-food',
      fallbackTexture: 'man-use-object',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 6,
    },
    {
      animationKey: 'man-anim-in-shower',
      texture: 'man-in-shower',
      fallbackTexture: 'man-use-object',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 6,
    },
    {
      animationKey: 'man-anim-on-toilet',
      texture: 'man-on-toilet',
      fallbackTexture: 'man-use-object',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 6,
    },
    {
      animationKey: 'man-anim-sitting-settee',
      texture: 'man-sitting-settee',
      fallbackTexture: 'man-sit-chair',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 5,
    },
    {
      animationKey: 'dog-anim-idle',
      texture: 'dog-idle',
      fallbackTexture: 'dog-walk-down',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 10,
    },
    {
      animationKey: 'dog-anim-sleep',
      texture: 'dog-sleep',
      fallbackTexture: 'dog-walk-down',
      frameCount: 36,
      framesPerRow: 6,
      frameRate: 8,
    },
    { animationKey: 'dog-anim-walk-down', texture: 'dog-walk-down', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-up', texture: 'dog-walk-up', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-left', texture: 'dog-walk-left', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    { animationKey: 'dog-anim-walk-right', texture: 'dog-walk-right', frameCount: 16, framesPerRow: 4, frameRate: 12 },
    {
      animationKey: 'dog-anim-eating-food',
      texture: 'dog-eating-food',
      fallbackTexture: 'dog-idle',
      frameCount: 16,
      framesPerRow: 4,
      frameRate: 6,
    },
  ];

  constructor() {
    super('LifeSimScene');
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      const optionalAnimationKeys = new Set([
        'man-idle-stand',
        'man-sit-forward',
        'man-sit-away',
        'man-nod',
        'man-shake',
        'man-dance',
        'man-knock',
        'man-running-machine',
        'dog-eating-food',
        'man-eating-food',
        'man-in-shower',
        'man-on-toilet',
        'man-sitting-settee',
        'dog-idle',
        'dog-sleep',
      ]);
      if (optionalAnimationKeys.has(file.key)) {
        this.missingOptionalTextures.add(file.key);
        return;
      }

      if (file.key.startsWith(LAYOUT_OBJECT_TEXTURE_PREFIX)) {
        this.missingLayoutTextureKeys.add(file.key);
      }
    });

    this.load.image('background', '/background/house-background.png');

    this.load.image('man-walk-down', '/sprites/man-walking-down.png');
    this.load.image('man-walk-up', '/sprites/man-walking-up.png');
    this.load.image('man-walk-left', '/sprites/man-walking-left.png');
    this.load.image('man-walk-right', '/sprites/man-walking-right.png');
    this.load.image('man-sleep', '/sprites/man-sleeping.png');
    this.load.image('man-use-object', '/sprites/man-using-object.png');
    // Optional dedicated clips. If files are missing, runtime fallbacks are used.
    this.load.image('man-idle-stand', '/sprites/idleman.png');
    this.load.image('man-sit-forward', '/sprites/sittingforward.png');
    this.load.image('man-sit-away', '/sprites/sitting-facing-away.png');
    this.load.image('man-nod', '/sprites/noddinghead.png');
    this.load.image('man-shake', '/sprites/shakinghead.png');
    this.load.image('man-dance', '/sprites/dancing-36frames.png');
    this.load.image('man-knock', '/sprites/knocking-on-the-screen-36frames.png');
    this.load.image('man-running-machine', '/sprites/running-runningmachine-36frames.png');
    this.load.image('man-eating-food', '/sprites/man-eatingfood.png');
    this.load.image('man-in-shower', '/sprites/man-inshower.png');
    this.load.image('man-on-toilet', '/sprites/man-ontoilet.png');
    this.load.image('man-sitting-settee', '/sprites/man-sitting-settee.png');
    // Legacy fallback clips retained for compatibility.
    this.load.image('man-sit-chair', '/sprites/man-sit-chair.png');
    this.load.image('man-use-computer', '/sprites/man-use-computer.png');

    this.load.image('dog-walk-down', '/sprites/dog-walking-down.png');
    this.load.image('dog-walk-up', '/sprites/dog-walking-up.png');
    this.load.image('dog-walk-left', '/sprites/dog-walking-left.png');
    this.load.image('dog-walk-right', '/sprites/dog-walking-right.png');
    this.load.image('dog-idle', '/sprites/dog-idle-36frames.png');
    this.load.image('dog-sleep', '/sprites/dog-sleeping-36frames.png');
    this.load.image('dog-eating-food', '/sprites/dog-eatingfood.png');

    const layoutObjects = (houseLayout.objects as LayoutPlacedObject[]) || [];
    const objectTypes = Array.from(new Set(layoutObjects.map((object) => object.type)));
    objectTypes.forEach((type) => {
      this.load.image(layoutObjectTextureKey(type), `/objects/${type}.png`);
    });
  }

  create(): void {
    const snapshot = loadSnapshot();
    this.identity = snapshot?.manIdentity || loadOrCreateIdentity();
    this.dayIndex = snapshot?.dayIndex || 1;

    const contractWorldSize = getWorldSizeFromContract();
    const backgroundSource = this.textures.get('background').getSourceImage() as
      | HTMLImageElement
      | HTMLCanvasElement
      | undefined;
    const worldSize = {
      width: Math.max(contractWorldSize.width, backgroundSource?.width ?? 0),
      height: Math.max(contractWorldSize.height, backgroundSource?.height ?? 0),
    };

    const background = this.add.image(0, 0, 'background').setOrigin(0, 0);
    background.setDisplaySize(worldSize.width, worldSize.height);
    background.setDepth(-1000);

    this.cameras.main.setBounds(0, 0, worldSize.width, worldSize.height);
    this.physics.world.setBounds(0, 0, worldSize.width, worldSize.height);

    this.grid = createNavigationGrid(runtimeContract);
    this.taskTargets = resolveTaskTargetCells(this.grid);
    this.actionAnchors = this.resolveActionAnchorsFromLayout();

    this.renderLayoutObjects();

    const manSpawn = runtimeContract.npcs.find((npc) => npc.id === 'man')?.spawn || { x: 1280, y: 1030 };
    const dogSpawn = runtimeContract.npcs.find((npc) => npc.id === 'dog')?.spawn || { x: 860, y: 1037 };

    this.prepareAllAnimations();

    const manScale = this.getSuggestedScale('man-walk-down', MAN_DESIRED_HEIGHT_PX);
    const dogScale = this.getSuggestedScale('dog-walk-down', DOG_DESIRED_HEIGHT_PX);

    this.man = {
      id: 'man',
      sprite: this.add.sprite(manSpawn.x, this.toRenderY(manSpawn.y, 'man'), 'man-walk-down', 0).setScale(manScale),
      path: [],
      currentTask: { type: 'idle', source: 'system', priority: 0, resumable: false },
      performUntilMs: 0,
      moveSpeed: MAN_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.dog = {
      id: 'dog',
      sprite: this.add.sprite(dogSpawn.x, this.toRenderY(dogSpawn.y, 'dog'), 'dog-walk-down', 0).setScale(dogScale),
      path: [],
      currentTask: { type: 'wander', source: 'system', priority: 0, resumable: false },
      performUntilMs: 0,
      moveSpeed: DOG_MOVE_SPEED,
      hiddenUntilMs: 0,
      pendingTargetCell: null,
    };

    this.playManIdle();
    this.playDogIdle();
    this.startupExplorationDueAtMs = this.time.now + STARTUP_EXPLORATION_DELAY_MS;
    this.lastPlayerInteractionAtMs = this.time.now;
    this.nextAttentionKnockAtMs = this.time.now + Phaser.Math.Between(ATTENTION_KNOCK_INTERVAL_MIN_MS, ATTENTION_KNOCK_INTERVAL_MAX_MS);

    this.emitLog('system', `${this.identity.name} moved in. Personality locked for this life.`);
    this.emitLog('system', 'Simulation hidden mode enabled. Use Ring Bell or polite commands.');
    this.emitLog('system', 'Phase 6.4 enabled: request memory, pacing sensitivity, and daily reflections.');
    this.reportOptionalAnimationFallbacks();
    this.reportMissingLayoutAssets();
    this.runStartupAudit();
    this.emitProfile();
  }

  update(time: number, delta: number): void {
    const deltaMs = Math.min(delta, 50);

    this.advanceDay(deltaMs, time);
    this.tickPlayerRequests(time);
    this.tickNarrativeEvents(time);
    this.tickMan(deltaMs, time);
    this.tickDog(deltaMs, time);
    this.tickAttentionSeeking(time);
    this.tickWashingCollect(time);

    this.identity.mood = tickMood(this.identity.mood, deltaMs, this.man.currentTask.type);

    if (time - this.lastProfilePushAt > PROFILE_REFRESH_INTERVAL_MS) {
      this.emitProfile();
      this.lastProfilePushAt = time;
    }

    this.applyOcclusionVisibility(this.man);
    this.applyOcclusionVisibility(this.dog);
    this.man.sprite.depth = this.getManDepth();
    this.dog.sprite.depth = this.toLogicalY(this.dog.sprite.y, 'dog');
  }

  public ringBell(): void {
    this.ringBellCount += 1;
    this.markPlayerInteraction();
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
    const reactionPlayed = this.triggerManReaction('nod', MAN_REACTION_BELL_MS);
    const enqueueDoorTask = (): void => {
      this.requestPriorityTask(
        { type: 'door_delivery', source: 'system', priority: INTERRUPT_PRIORITY_DOOR, resumable: false },
        'door delivery'
      );
    };

    if (reactionPlayed) {
      this.time.delayedCall(MAN_REACTION_BELL_MS, enqueueDoorTask);
    } else {
      enqueueDoorTask();
    }
  }

  public submitPlayerCommand(rawInput: string): void {
    const command = parsePlayerCommand(rawInput);
    this.emitLog('player', rawInput);
    this.markPlayerInteraction();

    if (!command.isUnderstood) {
      this.emitLog('system', command.feedback);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.recordCommandOutcome(false);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    if (!command.intent) {
      this.emitLog('man', 'He nods politely but does not change his routine.');
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    const intendedTask = this.resolveTaskWithAvailability(command.intent);
    if (intendedTask !== command.intent) {
      this.emitLog('system', `That request is unavailable in this layout. Falling back to ${textForTask(intendedTask)}.`);
    }

    const now = this.time.now;
    const cadencePenalty = this.getCadencePenalty(now);
    const repeatStreak = this.trackIntentStreak(intendedTask);
    this.lastRequestAtMs = now;

    if (this.hasDuplicatePendingRequest(command.normalized, intendedTask, now)) {
      this.emitLog('man', `${this.identity.name} gestures that this request is already in the queue.`);
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    if (repeatStreak >= 3 && cadencePenalty >= 0.1) {
      this.emitLog('man', `${this.identity.name} looks pressured and asks for fewer repeated commands.`);
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    if (this.playerRequests.length >= MAX_PENDING_PLAYER_REQUESTS) {
      this.emitLog('man', `${this.identity.name} seems overloaded and ignores the extra request.`);
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    const envelope: PlayerRequestEnvelope = {
      id: ++this.requestSequence,
      raw: rawInput,
      normalized: command.normalized,
      intent: intendedTask,
      enqueuedAtMs: now,
      resolveAtMs: now + this.getRequestResponseDelayMs(intendedTask, this.playerRequests.length),
      queueDepthAtEnqueue: this.playerRequests.length,
      repeatStreak,
      cadencePenalty,
    };

    this.playerRequests.push(envelope);
    this.emitLog('man', `${this.identity.name} is considering your request.`);
    if (repeatStreak >= 2) {
      this.emitLog('system', `${this.identity.name} noticed repeated requests for ${textForTask(intendedTask)}.`);
    }
    if (this.playerRequests.length > 1) {
      this.emitLog('system', `Request queue: ${this.playerRequests.length} pending.`);
    }
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
    if (!this.textures.exists(texture)) {
      return;
    }

    if (this.anims.exists(key)) {
      this.anims.remove(key);
    }

    this.anims.create({
      key,
      frames: this.anims.generateFrameNumbers(texture, { start: 0, end: frameCount - 1 }),
      frameRate,
      repeat: -1,
    });
  }

  private getSuggestedScale(textureKey: string, desiredHeightPx: number, fallbackScale = 1): number {
    if (!this.textures.exists(textureKey)) {
      return fallbackScale;
    }

    const texture = this.textures.get(textureKey);
    const frame = texture.get(0);
    const frameHeight = Math.max(1, frame.height);
    return desiredHeightPx / frameHeight;
  }

  private applyNpcScaleForTexture(npc: NpcRuntime, textureKey: string): void {
    const desiredHeight = npc.id === 'man' ? MAN_DESIRED_HEIGHT_PX : DOG_DESIRED_HEIGHT_PX;
    const currentScale = Math.max(0.001, npc.sprite.scaleX || 1);
    const scale = this.getSuggestedScale(textureKey, desiredHeight, currentScale);
    npc.sprite.setScale(scale);
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

  private markPlayerInteraction(now = this.time.now): void {
    this.lastPlayerInteractionAtMs = now;
    this.nextAttentionKnockAtMs = now + Phaser.Math.Between(ATTENTION_KNOCK_INTERVAL_MIN_MS, ATTENTION_KNOCK_INTERVAL_MAX_MS);
  }

  private reportOptionalAnimationFallbacks(): void {
    const fallbacks: Array<{ key: string; label: string; fallback: string }> = [
      { key: 'man-idle-stand', label: 'idle stand', fallback: 'man-walk-down' },
      { key: 'man-sit-forward', label: 'sit forward', fallback: 'man-sit-chair' },
      { key: 'man-sit-away', label: 'sit away', fallback: 'man-use-computer' },
      { key: 'man-nod', label: 'nod reaction', fallback: 'man-idle-stand' },
      { key: 'man-shake', label: 'shake reaction', fallback: 'man-idle-stand' },
      { key: 'man-dance', label: 'dance', fallback: 'man-use-object' },
      { key: 'man-knock', label: 'knock for attention', fallback: 'man-use-object' },
      { key: 'man-running-machine', label: 'running machine', fallback: 'man-use-object' },
      { key: 'man-eating-food', label: 'eating food', fallback: 'man-use-object' },
      { key: 'man-in-shower', label: 'in shower', fallback: 'man-use-object' },
      { key: 'man-on-toilet', label: 'on toilet', fallback: 'man-use-object' },
      { key: 'man-sitting-settee', label: 'sitting settee', fallback: 'man-sit-chair' },
      { key: 'dog-eating-food', label: 'dog eating', fallback: 'dog-idle' },
      { key: 'dog-idle', label: 'dog idle', fallback: 'dog-walk-down' },
      { key: 'dog-sleep', label: 'dog sleep', fallback: 'dog-walk-down' },
    ];

    fallbacks.forEach((item) => {
      if (this.missingOptionalTextures.has(item.key)) {
        this.emitLog('system', `Animation fallback active for ${item.label} (using ${item.fallback}).`);
      }
    });
  }

  private reportMissingLayoutAssets(): void {
    if (this.missingLayoutTextureKeys.size === 0) {
      return;
    }

    const missingTypes = Array.from(this.missingLayoutTextureKeys)
      .map((key) => key.replace(LAYOUT_OBJECT_TEXTURE_PREFIX, ''))
      .sort();
    this.emitLog('system', `Layout asset fallback: ${missingTypes.length} object texture(s) missing.`);
    missingTypes.forEach((type) => {
      this.emitLog('system', `Missing object texture: /objects/${type}.png`);
    });
  }

  private resolveActionAnchorsFromLayout(): Partial<Record<ActionAnchorKey, ActionAnchorPoint>> {
    const anchors: Partial<Record<ActionAnchorKey, ActionAnchorPoint>> = {};
    const coordinateScale = getLayoutToWorldScale();
    const layoutNavigation = (houseLayout as { navigation?: { action_anchors?: unknown; actionAnchors?: unknown } })
      .navigation;
    const runtimeAnchors = (runtimeContract as { interactionAnchors?: { actions?: unknown } }).interactionAnchors
      ?.actions;

    const applySource = (source: unknown, useLayoutScale: boolean): void => {
      if (!source || typeof source !== 'object') {
        return;
      }

      ACTION_ANCHOR_KEYS.forEach((key) => {
        if (anchors[key]) {
          return;
        }

        const point = (source as Record<string, unknown>)[key] as
          | { x?: unknown; y?: unknown; foreground?: unknown }
          | null;
        if (!point || typeof point !== 'object') {
          return;
        }

        const x = typeof point.x === 'number' && Number.isFinite(point.x) ? point.x : null;
        const y = typeof point.y === 'number' && Number.isFinite(point.y) ? point.y : null;
        if (x === null || y === null) {
          return;
        }

        anchors[key] = {
          x: useLayoutScale ? x * coordinateScale.x : x,
          y: useLayoutScale ? y * coordinateScale.y : y,
          foreground: point.foreground !== false,
        };
      });
    };

    applySource(layoutNavigation?.action_anchors ?? layoutNavigation?.actionAnchors, true);
    applySource(runtimeAnchors, false);
    return anchors;
  }

  private getActionAnchorPointForTask(task: TaskType): ActionAnchorPoint | null {
    const candidates = TASK_ACTION_ANCHOR_KEYS[task];
    if (!candidates || candidates.length === 0) {
      return null;
    }

    for (const key of candidates) {
      const point = this.actionAnchors[key];
      if (point) {
        return point;
      }
    }

    return null;
  }

  private getActionAnchorTargetCell(task: TaskType): CellKey | null {
    const point = this.getActionAnchorPointForTask(task);
    if (!point) {
      return null;
    }

    const cell = worldToCell(point, runtimeContract.gridSize);
    return findNearestWalkableCell(this.grid, cell);
  }

  private renderLayoutObjects(): void {
    const layoutObjects = ((houseLayout.objects as LayoutPlacedObject[]) || []).slice();
    const coordinateScale = getLayoutToWorldScale();
    const objectAnchor = getLayoutObjectAnchor();

    layoutObjects.sort((a, b) => {
      const zA = a.zIndex ?? 0;
      const zB = b.zIndex ?? 0;
      if (zA !== zB) {
        return zA - zB;
      }
      return a.y - b.y;
    });

    layoutObjects.forEach((object) => {
      const textureKey = layoutObjectTextureKey(object.type);
      if (!this.textures.exists(textureKey)) {
        return;
      }

      const renderX = object.x * coordinateScale.x;
      const renderY = object.y * coordinateScale.y;
      const baseScale = typeof object.scale === 'number' ? object.scale : 1;

      const sprite = this.add.image(renderX, renderY, textureKey);
      sprite.setOrigin(objectAnchor.x, objectAnchor.y);
      sprite.setScale(baseScale * coordinateScale.x, baseScale * coordinateScale.y);

      if (typeof object.rotation === 'number' && object.rotation !== 0) {
        sprite.setRotation(Phaser.Math.DegToRad(object.rotation));
      }

      const zIndex = typeof object.zIndex === 'number' ? object.zIndex : 0;
      sprite.setDepth(renderY + zIndex * LAYOUT_OBJECT_DEPTH_Z_MULTIPLIER);

      if (INTERACTIVE_OBJECT_TYPES.has(object.type)) {
        this.interactiveObjectSprites.set(object.type, sprite);
        sprite.setVisible(false);
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

  private advanceDay(deltaMs: number, time: number): void {
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
      const reflection = this.composeDailyReflection();
      this.dayElapsedMs = 0;
      this.dayIndex += 1;
      this.autoDeliveryTriggered = false;
      this.deliveryQueued = false;
      this.lastRoutineBeatIndex = -1;
      this.interruptedTaskStack = [];
      this.playerRequests = [];
      this.delayedNarrativeEvents = [];
      this.lastRequestedIntent = null;
      this.sameIntentStreak = 0;
      this.lastRequestAtMs = 0;
      this.dailyAcceptedCount = 0;
      this.dailyRejectedCount = 0;
      this.emitLog('system', `Day ${this.dayIndex} begins.`);
      this.emitAudioCue('routine_shift');
      if (reflection) {
        this.delayedNarrativeEvents.push({
          id: ++this.delayedEventSequence,
          atMs: time + DAILY_REFLECTION_DELAY_MS,
          type: 'daily_reflection',
          message: reflection,
        });
      }
      saveSnapshot({
        version: 1,
        manIdentity: this.identity,
        dayIndex: this.dayIndex,
      });
    }
  }

  private getRequestResponseDelayMs(intent: TaskType, pendingAhead: number): number {
    const baseMs = 1_200;
    const moodDelayMs = this.identity.mood.irritation * 1_400 + (1 - this.identity.mood.focus) * 1_000;
    const queueDelayMs = pendingAhead * 900;
    const intentDelayMs = intent === 'type_letter' ? 600 : 0;
    return Math.round(clamp(baseMs + moodDelayMs + queueDelayMs + intentDelayMs, 900, 7_200));
  }

  private getCadencePenalty(nowMs: number): number {
    if (this.lastRequestAtMs <= 0) {
      return 0;
    }

    const gapMs = nowMs - this.lastRequestAtMs;
    if (gapMs >= FAST_COMMAND_WINDOW_MS) {
      return 0;
    }

    const ratio = (FAST_COMMAND_WINDOW_MS - gapMs) / FAST_COMMAND_WINDOW_MS;
    return clamp(ratio * 0.22, 0, 0.22);
  }

  private trackIntentStreak(intent: TaskType): number {
    if (this.lastRequestedIntent === intent) {
      this.sameIntentStreak += 1;
    } else {
      this.sameIntentStreak = 1;
    }
    this.lastRequestedIntent = intent;
    return this.sameIntentStreak;
  }

  private hasDuplicatePendingRequest(normalized: string, intent: TaskType, nowMs: number): boolean {
    return this.playerRequests.some((request) => {
      if (request.normalized === normalized) {
        return true;
      }
      return request.intent === intent && nowMs - request.enqueuedAtMs <= DUPLICATE_REQUEST_WINDOW_MS;
    });
  }

  private tickPlayerRequests(time: number): void {
    if (this.playerRequests.length === 0) {
      return;
    }

    const dueRequests = this.playerRequests.filter((request) => request.resolveAtMs <= time);
    if (dueRequests.length === 0) {
      return;
    }

    this.playerRequests = this.playerRequests.filter((request) => request.resolveAtMs > time);
    dueRequests.forEach((request, index) => {
      const remaining = this.playerRequests.length + (dueRequests.length - index - 1);
      this.resolvePlayerRequest(request, remaining);
    });
  }

  private resolvePlayerRequest(request: PlayerRequestEnvelope, remainingQueueDepth: number): void {
    const accepts = this.rollCommandAcceptance(
      request.intent,
      remainingQueueDepth + request.queueDepthAtEnqueue,
      request.repeatStreak,
      request.cadencePenalty
    );
    if (!accepts) {
      this.emitLog('man', this.getRequestRejectionLine());
      this.recordCommandOutcome(false);
      this.identity.mood = onCommandRejected(this.identity.mood);
      this.emitAudioCue('negative');
      this.triggerManReaction('shake', MAN_REACTION_REJECT_MS);
      this.emitProfile();
      return;
    }

    const acceptedTask: NpcTask = {
      type: request.intent,
      fromPlayerCommand: request.normalized,
      source: 'player',
      priority: INTERRUPT_PRIORITY_PLAYER,
      resumable: true,
    };
    const reactionPlayed = this.triggerManReaction('nod', MAN_REACTION_ACK_MS);
    const enqueueAcceptedTask = (): void => {
      this.requestPriorityTask(acceptedTask, 'player request');
    };
    if (reactionPlayed) {
      this.time.delayedCall(MAN_REACTION_ACK_MS, enqueueAcceptedTask);
    } else {
      enqueueAcceptedTask();
    }
    this.emitLog('man', this.getRequestAcceptanceLine(request.intent, remainingQueueDepth, request.repeatStreak));
    if (remainingQueueDepth > 0) {
      this.delayedNarrativeEvents.push({
        id: ++this.delayedEventSequence,
        atMs: this.time.now + QUEUE_FOLLOWUP_DELAY_MS,
        type: 'queue_followup',
        message: this.composeQueueFollowupLine(remainingQueueDepth),
      });
    }
    this.recordCommandOutcome(true);
    this.identity.mood = onCommandAccepted(this.identity.mood);
    this.emitAudioCue('positive');
    this.emitProfile();
  }

  private getRequestAcceptanceLine(intent: TaskType, remainingQueueDepth: number, repeatStreak: number): string {
    if (repeatStreak >= 3) {
      return `I heard you. I will ${textForTask(intent)} once I catch up.`;
    }
    if (remainingQueueDepth > 0) {
      return `Okay. I will ${textForTask(intent)} after I clear a few things.`;
    }
    return `Okay, I will ${textForTask(intent)}.`;
  }

  private getRequestRejectionLine(): string {
    if (this.identity.mood.irritation > 0.65) {
      return `${this.identity.name} seems irritated and refuses this request.`;
    }
    if (this.identity.mood.energy < 0.35) {
      return `${this.identity.name} looks too tired to do that right now.`;
    }
    return `${this.identity.name} decides not to do that right now.`;
  }

  private tickNarrativeEvents(time: number): void {
    if (this.delayedNarrativeEvents.length === 0) {
      return;
    }

    const dueEvents = this.delayedNarrativeEvents.filter((event) => event.atMs <= time);
    if (dueEvents.length === 0) {
      return;
    }

    this.delayedNarrativeEvents = this.delayedNarrativeEvents.filter((event) => event.atMs > time);
    dueEvents.forEach((event) => {
      if (event.type === 'letter_reply') {
        this.emitLog('man', this.composeLetterReply());
        this.emitAudioCue('positive');
        return;
      }

      if (event.type === 'queue_followup' && event.message) {
        this.emitLog('man', event.message);
        this.emitAudioCue('routine_shift');
        return;
      }

      if (event.type === 'daily_reflection' && event.message) {
        this.emitLog('man', event.message);
        this.emitAudioCue('positive');
      }
    });
  }

  private composeQueueFollowupLine(remainingQueueDepth: number): string {
    if (remainingQueueDepth >= 2) {
      return `He says, "I still have ${remainingQueueDepth} requests queued. I will work through them."`;
    }
    return 'He says, "One more request is still pending. I have not forgotten."';
  }

  private composeLetterReply(): string {
    if (this.identity.mood.warmth > 0.7) {
      return 'He leaves a short letter: "Thank you for the note. I am in a good mood today."';
    }
    if (this.identity.mood.irritation > 0.68) {
      return 'He writes a brief letter: "I read your note. Please give me some space for now."';
    }
    if (this.identity.personality.diligence > 0.7) {
      return 'He writes: "Message received. I will keep to the routine and report back later."';
    }
    return 'He writes: "I got your note. I will do what I can today."';
  }

  private composeDailyReflection(): string | null {
    const total = this.dailyAcceptedCount + this.dailyRejectedCount;
    if (total === 0) {
      return null;
    }

    const acceptRate = this.dailyAcceptedCount / total;
    if (acceptRate >= 0.72) {
      return 'He leaves a daily note: "Today went smoothly. Thank you for being patient with me."';
    }
    if (acceptRate <= 0.32) {
      return 'He leaves a daily note: "Today felt crowded. Fewer repeated requests would help tomorrow."';
    }
    return 'He leaves a daily note: "Mixed day. I will try to balance my routine and your requests tomorrow."';
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

  private getCommandAcceptanceChance(
    intent: TaskType,
    queueDepthPenalty = 0,
    repeatStreak = 1,
    cadencePenalty = 0
  ): number {
    const acceptCount = this.commandOutcomes.filter(Boolean).length;
    const rejectCount = this.commandOutcomes.length - acceptCount;

    const chance = getComplianceChance(this.identity, {
      recentAcceptRate: this.commandOutcomes.length === 0 ? 0.5 : acceptCount / this.commandOutcomes.length,
      recentRejectRate: this.commandOutcomes.length === 0 ? 0 : rejectCount / this.commandOutcomes.length,
      ringBellCount: this.ringBellCount,
    });

    const isPlayfulTask = intent === 'dance' || intent === 'pet_dog';
    const taskBias = isPlayfulTask ? this.identity.personality.playfulness * 0.2 : this.identity.personality.diligence * 0.15;
    const queuePenalty = Math.min(0.28, queueDepthPenalty * 0.08);
    const repeatPenalty = Math.min(0.26, Math.max(0, repeatStreak - 1) * 0.09);
    const interactionBonus = this.dailyAcceptedCount > this.dailyRejectedCount ? 0.04 : 0;
    return clamp(chance + taskBias + interactionBonus - queuePenalty - repeatPenalty - cadencePenalty, 0.06, 0.95);
  }

  private rollCommandAcceptance(
    intent: TaskType,
    queueDepthPenalty = 0,
    repeatStreak = 1,
    cadencePenalty = 0
  ): boolean {
    return Math.random() < this.getCommandAcceptanceChance(intent, queueDepthPenalty, repeatStreak, cadencePenalty);
  }

  private recordCommandOutcome(accepted: boolean): void {
    this.commandOutcomes.push(accepted);
    if (accepted) {
      this.dailyAcceptedCount += 1;
    } else {
      this.dailyRejectedCount += 1;
    }
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

    if (this.manReactionUntilMs > 0) {
      if (time < this.manReactionUntilMs) {
        return;
      }
      this.manReactionUntilMs = 0;
      this.restoreManAnimationAfterReaction();
    }

    if (this.doorPhase !== 'none') {
      this.handleDoorFlow(time);
      return;
    }

    if (!this.startupExplorationQueued && time >= this.startupExplorationDueAtMs) {
      this.queueStartupExploration();
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
        this.applyNpcScaleForTexture(this.man, 'man-use-object');
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
    const actionAnchorForTask = this.getActionAnchorPointForTask(task);

    if (task === 'idle' || task === 'idle_stand') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        this.playNpcIdle(npc);
      }
      if (time >= npc.performUntilMs) {
        this.finishManTask(npc.currentTask, time);
      }
      return;
    }

    if (task === 'wander') {
      if (!npc.pendingTargetCell) {
        npc.pendingTargetCell = npc.currentTask.targetCell || pickRandomWalkableCell(this.grid);
      }
      const done = this.moveNpcToCell(npc, npc.pendingTargetCell, time);
      if (done) {
        this.finishManTask(npc.currentTask, time);
      }
      return;
    }

    if (task === 'sleep') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        this.applyNpcScaleForTexture(npc, 'man-sleep');
        npc.sprite.play('man-anim-sleep', true);
      }
      if (time >= npc.performUntilMs) {
        this.finishManTask(npc.currentTask, time);
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
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-idle-stand', 'man-walk-down'));
        npc.sprite.play('man-anim-idle-stand', true);
        this.pauseCurrentAnimation(npc.sprite);
        this.dog.path = [];
        this.playDogIdle();
        this.emitLog('man', `${this.identity.name} spends a moment with the dog.`);
      }

      if (time >= npc.performUntilMs) {
        this.dogInteractionCooldownUntilMs = time + 45_000;
        this.finishManTask(npc.currentTask, time);
      }
      return;
    }

    if (npc.performUntilMs > 0 && actionAnchorForTask) {
      // While anchored interactions are performing, lock to the anchor so movement checks do not
      // force idle/walk animations over the active interaction clip.
      npc.path = [];
      npc.pendingTargetCell = null;
      npc.sprite.setPosition(actionAnchorForTask.x, this.toRenderY(actionAnchorForTask.y, npc.id));

      if (time >= npc.performUntilMs) {
        this.finishManTask(npc.currentTask, time);
      } else {
        npc.sprite.anims.timeScale = 1 + deltaMs * 0.0001;
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
      if (actionAnchorForTask) {
        npc.sprite.setPosition(actionAnchorForTask.x, this.toRenderY(actionAnchorForTask.y, npc.id));
      }
      if (task === 'dance') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-dance', 'man-use-object'));
        npc.sprite.play('man-anim-dance', true);
      } else if (task === 'sit_chair' || task === 'sit_sofa') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-sit-forward', 'man-sit-chair'));
        npc.sprite.play('man-anim-sit-chair', true);
      } else if (task === 'sit_settee') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-sitting-settee', 'man-sit-chair'));
        npc.sprite.play('man-anim-sitting-settee', true);
      } else if (
        task === 'use_computer' ||
        task === 'play_piano' ||
        task === 'type_letter' ||
        task === 'play_another_song' ||
        task === 'sit_computer_desk' ||
        task === 'sit_piano'
      ) {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-sit-away', 'man-use-computer'));
        npc.sprite.play('man-anim-use-computer', true);
      } else if (task === 'lay_bed') {
        this.applyNpcScaleForTexture(npc, 'man-sleep');
        npc.sprite.play('man-anim-sleep', true);
      } else if (task === 'use_running_machine') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-running-machine', 'man-use-object'));
        npc.sprite.play('man-anim-running-machine', true);
      } else if (task === 'take_shower') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-in-shower', 'man-use-object'));
        npc.sprite.play('man-anim-in-shower', true);
      } else if (task === 'use_toilet') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-on-toilet', 'man-use-object'));
        npc.sprite.play('man-anim-on-toilet', true);
      } else if (task === 'eating_food') {
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-eating-food', 'man-use-object'));
        npc.sprite.play('man-anim-eating-food', true);
      } else if (
        task === 'use_fridge' ||
        task === 'use_kitchen_sink' ||
        task === 'use_washing_machine' ||
        task === 'use_dishwasher' ||
        task === 'open_kitchen_cupboard' ||
        task === 'use_bookcase' ||
        task === 'use_kitchen_worktop' ||
        task === 'use_cooker' ||
        task === 'use_wardrobe' ||
        task === 'collect_washing'
      ) {
        this.applyNpcScaleForTexture(npc, 'man-use-object');
        npc.sprite.play('man-anim-use-object', true);
      }
      this.showInteractiveObjectsForTask(task);
      return;
    }

    if (time >= npc.performUntilMs) {
      this.finishManTask(npc.currentTask, time);
    } else {
      // Keep subtle frame progression with animated clips.
      npc.sprite.anims.timeScale = 1 + deltaMs * 0.0001;
    }
  }

  private getTaskDuration(task: TaskType): number {
    const between = (minMs: number, maxMs: number): number => Phaser.Math.Between(minMs, maxMs);

    switch (task) {
      case 'idle':
      case 'idle_stand':
        return between(10_000, 22_000);
      case 'pet_dog':
        return between(20_000, 40_000);
      case 'sit_chair':
      case 'sit_sofa':
      case 'sit_settee':
        return between(20_000, 55_000);
      case 'sit_computer_desk':
      case 'sit_piano':
        return between(30_000, 120_000);
      case 'lay_bed':
        return between(35_000, 90_000);
      case 'use_computer':
        return between(30_000, 120_000);
      case 'type_letter':
        return between(30_000, 95_000);
      case 'use_running_machine':
        return between(60_000, 150_000);
      case 'take_shower':
        return between(20_000, 45_000);
      case 'use_toilet':
        return between(20_000, 35_000);
      case 'use_fridge':
        return between(20_000, 32_000);
      case 'use_kitchen_sink':
        return between(20_000, 40_000);
      case 'use_washing_machine':
        return between(20_000, 45_000);
      case 'use_dishwasher':
        return between(20_000, 42_000);
      case 'open_kitchen_cupboard':
        return between(20_000, 36_000);
      case 'use_bookcase':
        return between(20_000, 45_000);
      case 'use_kitchen_worktop':
        return between(20_000, 50_000);
      case 'use_cooker':
        return between(20_000, 55_000);
      case 'use_wardrobe':
        return between(20_000, 40_000);
      case 'play_piano':
        return between(40_000, 150_000);
      case 'play_another_song':
        return between(35_000, 120_000);
      case 'dance':
        return between(20_000, 45_000);
      case 'eating_food':
        return between(10_000, 20_000);
      case 'collect_washing':
        return between(8_000, 12_000);
      default:
        return between(20_000, 35_000);
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
      case 'sit_sofa':
      case 'sit_settee':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.chair;
      case 'sit_computer_desk':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.computerDesk || this.taskTargets.letterDesk;
      case 'sit_piano':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.piano;
      case 'lay_bed':
      case 'take_shower':
      case 'use_toilet':
      case 'use_fridge':
      case 'use_kitchen_sink':
      case 'use_washing_machine':
      case 'use_dishwasher':
      case 'open_kitchen_cupboard':
      case 'use_bookcase':
      case 'use_kitchen_worktop':
      case 'use_cooker':
      case 'use_wardrobe':
        return this.getActionAnchorTargetCell(task);
      case 'use_computer':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.computerDesk || this.taskTargets.letterDesk;
      case 'use_running_machine':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.runningMachine;
      case 'play_piano':
      case 'play_another_song':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.piano;
      case 'type_letter':
        return this.getActionAnchorTargetCell(task) || this.taskTargets.letterDesk;
      case 'eating_food':
        return this.getActionAnchorTargetCell('use_cooker');
      case 'collect_washing':
        return this.getActionAnchorTargetCell('use_washing_machine');
      default:
        return null;
    }
  }

  private getDogInteractionCell(): CellKey | null {
    const dogCell = worldToCell({ x: this.dog.sprite.x, y: this.toLogicalY(this.dog.sprite.y, 'dog') }, runtimeContract.gridSize);
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
      task === 'sit_sofa' ||
      task === 'sit_settee' ||
      task === 'sit_computer_desk' ||
      task === 'sit_piano' ||
      task === 'lay_bed' ||
      task === 'take_shower' ||
      task === 'use_toilet' ||
      task === 'use_fridge' ||
      task === 'use_kitchen_sink' ||
      task === 'use_washing_machine' ||
      task === 'use_dishwasher' ||
      task === 'open_kitchen_cupboard' ||
      task === 'use_bookcase' ||
      task === 'use_kitchen_worktop' ||
      task === 'use_cooker' ||
      task === 'use_wardrobe' ||
      task === 'use_computer' ||
      task === 'use_running_machine' ||
      task === 'play_piano' ||
      task === 'play_another_song' ||
      task === 'type_letter' ||
      task === 'eating_food' ||
      task === 'collect_washing' ||
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

  private finishManTask(completedTask?: NpcTask, completedAtMs?: number): void {
    if (completedTask && completedAtMs !== undefined) {
      this.onTaskCompleted(completedTask, completedAtMs);
    }

    this.man.currentTask = { type: 'idle', source: 'system', priority: 0, resumable: false };
    this.man.performUntilMs = 0;
    this.man.pendingTargetCell = null;
    this.man.path = [];
    this.playManIdle();
  }

  private onTaskCompleted(task: NpcTask, completedAtMs: number): void {
    if (task.source === 'player') {
      this.emitLog('system', `Request completed: ${textForTask(task.type)}.`);
    }

    if (task.type === 'type_letter' && task.source === 'player') {
      this.emitLog('system', `${this.identity.name} finished writing a reply.`);
      this.delayedNarrativeEvents.push({
        id: ++this.delayedEventSequence,
        atMs: completedAtMs + LETTER_REPLY_DELAY_MS,
        type: 'letter_reply',
      });
    }

    if (task.type === 'use_cooker') {
      this.hideInteractiveObjectsForTask('use_cooker');
      this.emitLog('man', `${this.identity.name} finished cooking and sits down to eat.`);
      this.enqueueTask(
        { type: 'eating_food', source: 'system', priority: 50, resumable: false },
        true
      );
    }

    if (task.type === 'eating_food') {
      this.emitLog('man', `${this.identity.name} finished eating and goes to wash up.`);
      this.enqueueTask(
        { type: 'use_dishwasher', source: 'system', priority: 50, resumable: false, remainingMs: 10_000 },
        true
      );
    }

    if (task.type === 'use_fridge') {
      this.hideInteractiveObjectsForTask('use_fridge');
    }

    if (task.type === 'open_kitchen_cupboard') {
      this.hideInteractiveObjectsForTask('open_kitchen_cupboard');
    }

    if (task.type === 'use_dishwasher') {
      this.hideInteractiveObjectsForTask('use_dishwasher');
    }

    if (task.type === 'use_wardrobe') {
      this.hideInteractiveObjectsForTask('use_wardrobe');
    }

    if (task.type === 'use_washing_machine') {
      this.washingCollectDueAtMs = completedAtMs + Phaser.Math.Between(WASHING_COLLECT_DELAY_MIN_MS, WASHING_COLLECT_DELAY_MAX_MS);
      this.emitLog('system', 'The washing machine is running. He will collect it later.');
    }

    if (task.type === 'collect_washing') {
      this.setInteractiveObjectVisible('washingmachine_3x4_full', false);
      this.emitLog('man', `${this.identity.name} collected the washing.`);
    }
  }

  private moveNpcToCell(npc: NpcRuntime, targetCell: CellKey, time: number): boolean {
    if (npc.path.length === 0 || npc.pendingTargetCell !== targetCell) {
      this.rebuildPathForNpc(npc, targetCell);
    }

    if (npc.path.length === 0) {
      const atTarget = this.isNpcAtCell(npc, targetCell);
      if (!atTarget) {
        this.playNpcIdle(npc);
        npc.pendingTargetCell = null;
        return true;
      }
      return atTarget;
    }

    const nextCell = npc.path[0];
    const nextPoint = cellToWorldCenter(nextCell, runtimeContract.gridSize);
    const targetY = this.toRenderY(nextPoint.y, npc.id);
    const dx = nextPoint.x - npc.sprite.x;
    const dy = targetY - npc.sprite.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= 1.4) {
      npc.sprite.setPosition(nextPoint.x, targetY);
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
    const current = worldToCell({ x: npc.sprite.x, y: this.toLogicalY(npc.sprite.y, npc.id) }, runtimeContract.gridSize);
    return current === cell;
  }

  private rebuildPathForNpc(npc: NpcRuntime, targetCell: CellKey): void {
    const currentCell = worldToCell({ x: npc.sprite.x, y: this.toLogicalY(npc.sprite.y, npc.id) }, runtimeContract.gridSize);
    const start = findNearestWalkableCell(this.grid, currentCell) || targetCell;
    const goal = findNearestWalkableCell(this.grid, targetCell) || targetCell;

    const nextPath = findPathBfs(this.grid, start, goal);
    npc.path = nextPath.slice(1);
    npc.pendingTargetCell = targetCell;
  }

  private playWalkAnimation(npc: NpcRuntime, direction: 'left' | 'right' | 'up' | 'down', time: number): void {
    if (npc.id === 'man') {
      const manTextureKey =
        direction === 'left'
          ? 'man-walk-left'
          : direction === 'right'
            ? 'man-walk-right'
            : direction === 'up'
              ? 'man-walk-up'
              : 'man-walk-down';
      const key =
        direction === 'left'
          ? 'man-anim-walk-left'
          : direction === 'right'
            ? 'man-anim-walk-right'
            : direction === 'up'
              ? 'man-anim-walk-up'
              : 'man-anim-walk-down';
      this.applyNpcScaleForTexture(npc, manTextureKey);
      npc.sprite.play(key, true);
      return;
    }

    const dogTextureKey =
      direction === 'left'
        ? 'dog-walk-left'
        : direction === 'right'
          ? 'dog-walk-right'
          : direction === 'up'
            ? 'dog-walk-up'
            : 'dog-walk-down';
    const dogKey =
      direction === 'left'
        ? 'dog-anim-walk-left'
        : direction === 'right'
          ? 'dog-anim-walk-right'
          : direction === 'up'
            ? 'dog-anim-walk-up'
            : 'dog-anim-walk-down';
    this.applyNpcScaleForTexture(npc, dogTextureKey);
    npc.sprite.play(dogKey, true);

    if (time % 8000 < 16) {
      npc.sprite.anims.timeScale = 1;
    }
  }

  private playManIdle(): void {
    this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-idle-stand', 'man-walk-down'));
    this.man.sprite.play('man-anim-idle-stand', true);
    this.pauseCurrentAnimation(this.man.sprite);
  }

  private triggerManAttentionKnock(durationMs: number): boolean {
    if (this.man.hiddenUntilMs > 0 || !this.man.sprite.visible) {
      return false;
    }

    this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-knock', 'man-use-object'));
    this.man.sprite.play('man-anim-knock', true);
    this.manReactionUntilMs = Math.max(this.manReactionUntilMs, this.time.now + Math.max(120, durationMs));
    return true;
  }

  private triggerManReaction(kind: 'nod' | 'shake', durationMs: number): boolean {
    if (this.man.hiddenUntilMs > 0 || !this.man.sprite.visible) {
      return false;
    }

    if (kind === 'nod') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-nod', 'man-idle-stand'));
      this.man.sprite.play('man-anim-nod', true);
    } else {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-shake', 'man-idle-stand'));
      this.man.sprite.play('man-anim-shake', true);
    }

    this.manReactionUntilMs = Math.max(this.manReactionUntilMs, this.time.now + Math.max(120, durationMs));
    return true;
  }

  private restoreManAnimationAfterReaction(): void {
    const task = this.man.currentTask.type;

    if (task === 'sleep') {
      this.applyNpcScaleForTexture(this.man, 'man-sleep');
      this.man.sprite.play('man-anim-sleep', true);
      return;
    }

    if (task === 'sit_chair' || task === 'sit_sofa') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-sit-forward', 'man-sit-chair'));
      this.man.sprite.play('man-anim-sit-chair', true);
      return;
    }

    if (task === 'sit_settee') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-sitting-settee', 'man-sit-chair'));
      this.man.sprite.play('man-anim-sitting-settee', true);
      return;
    }

    if (
      task === 'use_computer' ||
      task === 'play_piano' ||
      task === 'play_another_song' ||
      task === 'type_letter' ||
      task === 'sit_computer_desk' ||
      task === 'sit_piano'
    ) {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-sit-away', 'man-use-computer'));
      this.man.sprite.play('man-anim-use-computer', true);
      return;
    }

    if (task === 'lay_bed') {
      this.applyNpcScaleForTexture(this.man, 'man-sleep');
      this.man.sprite.play('man-anim-sleep', true);
      return;
    }

    if (task === 'dance') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-dance', 'man-use-object'));
      this.man.sprite.play('man-anim-dance', true);
      return;
    }

    if (task === 'use_running_machine') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-running-machine', 'man-use-object'));
      this.man.sprite.play('man-anim-running-machine', true);
      return;
    }

    if (task === 'take_shower') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-in-shower', 'man-use-object'));
      this.man.sprite.play('man-anim-in-shower', true);
      return;
    }

    if (task === 'use_toilet') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-on-toilet', 'man-use-object'));
      this.man.sprite.play('man-anim-on-toilet', true);
      return;
    }

    if (task === 'eating_food') {
      this.applyNpcScaleForTexture(this.man, this.resolveTexture('man-eating-food', 'man-use-object'));
      this.man.sprite.play('man-anim-eating-food', true);
      return;
    }

    if (
      task === 'use_fridge' ||
      task === 'use_kitchen_sink' ||
      task === 'use_washing_machine' ||
      task === 'use_dishwasher' ||
      task === 'open_kitchen_cupboard' ||
      task === 'use_bookcase' ||
      task === 'use_kitchen_worktop' ||
      task === 'use_cooker' ||
      task === 'use_wardrobe' ||
      task === 'collect_washing'
    ) {
      this.applyNpcScaleForTexture(this.man, 'man-use-object');
      this.man.sprite.play('man-anim-use-object', true);
      return;
    }

    this.playManIdle();
  }

  private showInteractiveObjectsForTask(task: TaskType): void {
    INTERACTIVE_OBJECT_TYPES.forEach((config, objectType) => {
      if (config.task !== task) {
        return;
      }
      const sprite = this.interactiveObjectSprites.get(objectType);
      if (sprite) {
        sprite.setVisible(true);
      }
    });
  }

  private hideInteractiveObjectsForTask(task: TaskType, forceHide = false): void {
    INTERACTIVE_OBJECT_TYPES.forEach((config, objectType) => {
      if (config.task !== task) {
        return;
      }

      // Washing machine is handled separately via collect_washing
      if (objectType === 'washingmachine_3x4_full') {
        return;
      }

      const sprite = this.interactiveObjectSprites.get(objectType);
      if (!sprite) {
        return;
      }

      if (forceHide || Math.random() >= FORGET_CHANCE) {
        sprite.setVisible(false);
      } else {
        this.emitLog('system', `${this.identity.name} forgot to tidy up after using the ${textForTask(task).replace('use the ', '').replace('open a ', '')}.`);
      }
    });
  }

  private setInteractiveObjectVisible(objectType: string, visible: boolean): void {
    const sprite = this.interactiveObjectSprites.get(objectType);
    if (sprite) {
      sprite.setVisible(visible);
    }
  }

  private tickWashingCollect(time: number): void {
    if (this.washingCollectDueAtMs <= 0 || time < this.washingCollectDueAtMs) {
      return;
    }

    this.washingCollectDueAtMs = 0;
    this.emitLog('system', `${this.identity.name} remembers the washing is done.`);
    this.enqueueTask(
      { type: 'collect_washing', source: 'system', priority: 45, resumable: true },
      true
    );
  }

  private playDogIdle(): void {
    const texture = this.resolveTexture('dog-idle', 'dog-walk-down');
    this.applyNpcScaleForTexture(this.dog, texture);
    this.dog.sprite.play('dog-anim-idle', true);
    if (texture === 'dog-walk-down') {
      this.pauseCurrentAnimation(this.dog.sprite);
    }
  }

  private playDogSleep(): void {
    const texture = this.resolveTexture('dog-sleep', 'dog-walk-down');
    this.applyNpcScaleForTexture(this.dog, texture);
    this.dog.sprite.play('dog-anim-sleep', true);
    if (texture === 'dog-walk-down') {
      this.pauseCurrentAnimation(this.dog.sprite);
    }
  }

  private playDogEating(): void {
    const texture = this.resolveTexture('dog-eating-food', 'dog-idle');
    this.applyNpcScaleForTexture(this.dog, texture);
    this.dog.sprite.play('dog-anim-eating-food', true);
    if (texture === 'dog-idle' || texture === 'dog-walk-down') {
      this.pauseCurrentAnimation(this.dog.sprite);
    }
  }

  private getDogAnchorTargetCell(anchorKey: ActionAnchorKey): CellKey | null {
    const point = this.actionAnchors[anchorKey];
    if (!point) {
      return null;
    }
    const cell = worldToCell(point, runtimeContract.gridSize);
    return findNearestWalkableCell(this.grid, cell);
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

  private queueStartupExploration(): void {
    if (this.startupExplorationQueued) {
      return;
    }

    this.startupExplorationQueued = true;
    const route = this.buildStartupExplorationRoute();
    if (route.length === 0) {
      this.requestPriorityTask(
        { type: 'wander', source: 'system', priority: STARTUP_EXPLORATION_PRIORITY, resumable: false },
        'startup exploration'
      );
      return;
    }

    this.emitLog('system', `${this.identity.name} starts exploring the house.`);

    route.forEach((targetCell, index) => {
      const task: NpcTask = {
        type: 'wander',
        targetCell,
        source: 'system',
        priority: STARTUP_EXPLORATION_PRIORITY,
        resumable: false,
      };

      if (index === 0) {
        this.requestPriorityTask(task, 'startup exploration');
      } else {
        this.enqueueTask(task);
      }
    });
  }

  private buildStartupExplorationRoute(): CellKey[] {
    const route: CellKey[] = [];
    const seen = new Set<CellKey>();

    const addRouteCell = (candidate: CellKey | null): void => {
      if (!candidate) {
        return;
      }

      const resolved = findNearestWalkableCell(this.grid, candidate);
      if (!resolved || seen.has(resolved)) {
        return;
      }

      seen.add(resolved);
      route.push(resolved);
    };

    addRouteCell(this.taskTargets.piano);
    addRouteCell(this.taskTargets.runningMachine);
    addRouteCell(this.taskTargets.chair);
    addRouteCell(this.taskTargets.computerDesk || this.taskTargets.letterDesk);
    addRouteCell(this.taskTargets.door);

    const walkableCells: Array<{ col: number; row: number }> = [];
    for (const key of this.grid.walkable) {
      const parsed = parseCellKey(key);
      if (parsed) {
        walkableCells.push(parsed);
      }
    }

    if (walkableCells.length > 0) {
      let minCol = walkableCells[0].col;
      let maxCol = walkableCells[0].col;
      let minRow = walkableCells[0].row;
      let maxRow = walkableCells[0].row;

      walkableCells.forEach((cell) => {
        if (cell.col < minCol) minCol = cell.col;
        if (cell.col > maxCol) maxCol = cell.col;
        if (cell.row < minRow) minRow = cell.row;
        if (cell.row > maxRow) maxRow = cell.row;
      });

      const samples = [
        { x: 0.08, y: 0.15 },
        { x: 0.5, y: 0.15 },
        { x: 0.9, y: 0.15 },
        { x: 0.12, y: 0.5 },
        { x: 0.86, y: 0.5 },
        { x: 0.12, y: 0.86 },
        { x: 0.5, y: 0.86 },
        { x: 0.9, y: 0.86 },
      ];

      samples.forEach((sample) => {
        const col = Math.round(minCol + (maxCol - minCol) * sample.x);
        const row = Math.round(minRow + (maxRow - minRow) * sample.y);
        addRouteCell(toCellKey(col, row));
      });
    }

    return route;
  }

  private getDeterministicBeatRoll(beatIndex: number, salt: number): number {
    const normalizedBeat = Math.max(0, beatIndex);
    const seed = this.identity.appearanceSeed + this.dayIndex * 101 + normalizedBeat * 37 + salt * 13;
    const x = Math.sin(seed * 0.0009) * 10000;
    return x - Math.floor(x);
  }

  private tickAttentionSeeking(time: number): void {
    if (time < this.nextAttentionKnockAtMs) {
      return;
    }

    const inactivityMs = time - this.lastPlayerInteractionAtMs;
    if (inactivityMs < ATTENTION_IDLE_THRESHOLD_MS) {
      this.nextAttentionKnockAtMs = this.lastPlayerInteractionAtMs + ATTENTION_IDLE_THRESHOLD_MS;
      return;
    }

    if (
      this.man.hiddenUntilMs > 0 ||
      this.doorPhase !== 'none' ||
      this.manReactionUntilMs > 0 ||
      this.man.currentTask.type !== 'idle' ||
      this.man.performUntilMs > 0 ||
      this.man.path.length > 0 ||
      this.manTaskQueue.length > 0 ||
      this.playerRequests.length > 0
    ) {
      this.nextAttentionKnockAtMs = time + 15_000;
      return;
    }

    const prompts = [
      'Are you still there? He knocks on the screen to get your attention.',
      `${this.identity.name} taps the screen and hints that he feels hungry.`,
      `${this.identity.name} knocks and says the dog seems hungry too.`,
    ];
    const prompt = prompts[this.attentionReasonCursor % prompts.length];
    this.attentionReasonCursor += 1;

    const triggered = this.triggerManAttentionKnock(MAN_REACTION_KNOCK_MS);
    if (triggered) {
      this.emitLog('man', prompt);
      this.emitAudioCue('positive');
    }

    this.nextAttentionKnockAtMs = time + Phaser.Math.Between(ATTENTION_KNOCK_INTERVAL_MIN_MS, ATTENTION_KNOCK_INTERVAL_MAX_MS);
  }

  private tickDog(_deltaMs: number, time: number): void {
    if (this.man.currentTask.type === 'pet_dog') {
      this.dog.currentTask = { type: 'idle' };
      this.dog.performUntilMs = 0;
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

    // Night sleep — always sleep after 90% of day at the anchor if available
    if (dayRatio > 0.9) {
      if (this.dog.currentTask.type !== 'sleep') {
        this.dog.currentTask = { type: 'sleep' };
        this.dog.performUntilMs = 0;
      }
      const sleepAnchorCell = this.getDogAnchorTargetCell('dog_sleeping');
      if (sleepAnchorCell && !this.isNpcAtCell(this.dog, sleepAnchorCell)) {
        const reached = this.moveNpcToCell(this.dog, sleepAnchorCell, time);
        if (reached) {
          const anchor = this.actionAnchors['dog_sleeping'];
          if (anchor) {
            this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
          }
          this.playDogSleep();
        }
      } else {
        this.dog.path = [];
        if (sleepAnchorCell) {
          const anchor = this.actionAnchors['dog_sleeping'];
          if (anchor) {
            this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
          }
        }
        this.playDogSleep();
      }
      return;
    }

    // Dog is performing a timed activity (sleeping or eating during the day)
    if (this.dog.performUntilMs > 0) {
      if (time < this.dog.performUntilMs) {
        return;
      }
      // Activity finished
      this.dog.performUntilMs = 0;
      this.dog.currentTask = { type: 'wander' };
      this.dogActivityCooldownUntilMs = time + 60_000;
      this.playDogIdle();
    }

    // Wake from night sleep if day started again
    if (this.dog.currentTask.type === 'sleep') {
      this.dog.currentTask = { type: 'wander' };
    }

    // Pick a new activity when the dog finishes wandering and is idle
    if (this.dog.path.length === 0 && this.dog.currentTask.type === 'wander' && time >= this.dogActivityCooldownUntilMs) {
      const roll = Math.random();

      // Try to nap at anchor
      if (roll < DOG_SLEEP_CHANCE) {
        const sleepCell = this.getDogAnchorTargetCell('dog_sleeping');
        if (sleepCell) {
          this.dog.currentTask = { type: 'sleep' };
          this.dog.pendingTargetCell = sleepCell;
          const reached = this.moveNpcToCell(this.dog, sleepCell, time);
          if (reached) {
            const anchor = this.actionAnchors['dog_sleeping'];
            if (anchor) {
              this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
            }
            this.dog.performUntilMs = time + Phaser.Math.Between(DOG_SLEEP_DURATION_MIN_MS, DOG_SLEEP_DURATION_MAX_MS);
            this.playDogSleep();
            this.emitLog('system', 'The dog curls up for a nap.');
          }
          return;
        }
      }

      // Try to eat at anchor
      if (roll < DOG_SLEEP_CHANCE + DOG_EAT_CHANCE) {
        const eatCell = this.getDogAnchorTargetCell('dog_eating');
        if (eatCell) {
          this.dog.currentTask = { type: 'idle' };
          this.dog.pendingTargetCell = eatCell;
          const reached = this.moveNpcToCell(this.dog, eatCell, time);
          if (reached) {
            const anchor = this.actionAnchors['dog_eating'];
            if (anchor) {
              this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
            }
            this.dog.performUntilMs = time + DOG_EAT_DURATION_MS;
            this.playDogEating();
            this.emitLog('system', 'The dog eats some food.');
          }
          return;
        }
      }
    }

    // Dog is walking to a sleep/eat anchor — keep moving
    if (this.dog.currentTask.type === 'sleep' && this.dog.pendingTargetCell) {
      const sleepCell = this.dog.pendingTargetCell;
      const reached = this.moveNpcToCell(this.dog, sleepCell, time);
      if (reached) {
        const anchor = this.actionAnchors['dog_sleeping'];
        if (anchor) {
          this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
        }
        this.dog.performUntilMs = time + Phaser.Math.Between(DOG_SLEEP_DURATION_MIN_MS, DOG_SLEEP_DURATION_MAX_MS);
        this.playDogSleep();
        this.emitLog('system', 'The dog curls up for a nap.');
      }
      return;
    }

    if (this.dog.currentTask.type === 'idle' && this.dog.pendingTargetCell && this.dog.performUntilMs === 0) {
      const eatCell = this.dog.pendingTargetCell;
      const reached = this.moveNpcToCell(this.dog, eatCell, time);
      if (reached) {
        const anchor = this.actionAnchors['dog_eating'];
        if (anchor) {
          this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
        }
        this.dog.performUntilMs = time + DOG_EAT_DURATION_MS;
        this.playDogEating();
        this.emitLog('system', 'The dog eats some food.');
      }
      return;
    }

    // Default wandering behavior
    if (this.dog.path.length === 0) {
      const manCell = worldToCell({ x: this.man.sprite.x, y: this.toLogicalY(this.man.sprite.y, 'man') }, runtimeContract.gridSize);
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
      const targetY = this.toRenderY(nextPoint.y, 'dog');
      const dx = nextPoint.x - this.dog.sprite.x;
      const dy = targetY - this.dog.sprite.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= 1.5) {
        this.dog.sprite.setPosition(nextPoint.x, targetY);
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

  private getRenderYOffset(npcId: NpcRuntime['id']): number {
    return npcId === 'man' ? MAN_RENDER_Y_OFFSET : DOG_RENDER_Y_OFFSET;
  }

  private toRenderY(logicalY: number, npcId: NpcRuntime['id']): number {
    return logicalY + this.getRenderYOffset(npcId);
  }

  private toLogicalY(renderY: number, npcId: NpcRuntime['id']): number {
    return renderY - this.getRenderYOffset(npcId);
  }

  private isForegroundInteractionTask(task: TaskType): boolean {
    const actionAnchor = this.getActionAnchorPointForTask(task);
    return Boolean(actionAnchor && actionAnchor.foreground !== false);
  }

  private getManDepth(): number {
    const baseDepth = this.toLogicalY(this.man.sprite.y, 'man');
    const isForegroundInteraction =
      this.man.performUntilMs > 0 &&
      this.man.path.length === 0 &&
      this.isForegroundInteractionTask(this.man.currentTask.type);
    return isForegroundInteraction ? baseDepth + MAN_INTERACTION_DEPTH_BOOST : baseDepth;
  }

  private getDogCompanionCellNearMan(): CellKey | null {
    const manCell = worldToCell({ x: this.man.sprite.x, y: this.toLogicalY(this.man.sprite.y, 'man') }, runtimeContract.gridSize);
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
    const logicalY = this.toLogicalY(npc.sprite.y, npc.id);
    const hidden = zones.some((zone) => {
      if (zone.mode === 'show') {
        return false;
      }

      return (
        npc.sprite.x >= zone.x &&
        npc.sprite.x <= zone.x + zone.width &&
        logicalY >= zone.y &&
        logicalY <= zone.y + zone.height
      );
    });

    npc.sprite.setVisible(!hidden);
  }
}
