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
const DOG_SLEEP_DURATION_MIN_MS = 120_000;
const DOG_SLEEP_DURATION_MAX_MS = 240_000;
const DOG_EAT_DURATION_MS = 20_000;
const DOG_SLEEP_CHANCE = 0.12;
const DOG_EAT_CHANCE = 0.08;
const WASHING_COLLECT_DELAY_MIN_MS = 300_000;
const WASHING_COLLECT_DELAY_MAX_MS = 600_000;
const FORGET_CHANCE = 0.35;
const MAN_HUNGER_RATE_PER_MIN = 0.012;
const DOG_HUNGER_RATE_PER_MIN = 0.008;
const MAN_HUNGER_COOK_THRESHOLD = 0.55;
const MAN_HUNGER_SICK_THRESHOLD = 0.85;
const DOG_HUNGER_EAT_THRESHOLD = 0.5;
const FOOD_PER_DELIVERY = 5;
const DOG_FOOD_PER_DELIVERY = 3;
const FOOD_PER_MEAL = 1;
const DOG_FOOD_PER_MEAL = 1;
const INITIAL_FOOD_SUPPLY = 4;
const INITIAL_DOG_FOOD_SUPPLY = 3;
const IRRITATION_AUTO_RELIEF_THRESHOLD = 0.4;

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
  'use_tv',
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
  sleep: ['lay_bed'],
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
  use_tv: ['use_tv'],
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
    case 'use_tv':
      return 'watch TV';
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
  private manHunger = 0;
  private dogHunger = 0;
  private foodSupply = INITIAL_FOOD_SUPPLY;
  private dogFoodSupply = INITIAL_DOG_FOOD_SUPPLY;
  private manIsSick = false;
  private hungerCookingQueued = false;
  private irritationReliefQueued = false;

  // Sound effect state
  private sfxWalking: Phaser.Sound.BaseSound | null = null;
  private sfxStairs: Phaser.Sound.BaseSound | null = null;
  private sfxShower: Phaser.Sound.BaseSound | null = null;
  private sfxSleeping: Phaser.Sound.BaseSound | null = null;
  private sfxGameSound: Phaser.Sound.BaseSound | null = null;
  private sfxInteraction: Phaser.Sound.BaseSound | null = null;
  private sfxPiano: Phaser.Sound.BaseSound | null = null;
  private lastPianoTrackIndex = -1;
  private manWalkDirection: 'left' | 'right' | 'up' | 'down' | null = null;
  private alarmClockScheduled = false;
  private nextSnoreAtMs = 0;
  private lastSfxTaskType: TaskType | null = null;
  public musicVolume = 0.5;
  public sfxVolume = 0.5;
  private bgMusic: Phaser.Sound.BaseSound | null = null;
  private tvVideo: Phaser.GameObjects.Video | null = null;
  private tvVideoPlaying = false;
  private tvMesh: Phaser.GameObjects.Mesh | null = null;
  private tvCanvasTexture: Phaser.Textures.CanvasTexture | null = null;
  private lastBgMusicIndex = -1;
  private nextBgMusicAtMs = 0;
  private bgMusicFadingOut = false;
  private static readonly BG_MUSIC_COUNT = 6;

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

    this.load.video('tv-movie', '/movies/101-Dalmatians.mp4');
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

    // Sound effects
    this.load.audio('sfx-alarmclock', '/sounds/soundeffects/alarmclock.ogg');
    this.load.audio('sfx-cooker', '/sounds/soundeffects/cooker.ogg');
    this.load.audio('sfx-cupboard', '/sounds/soundeffects/cupboard.ogg');
    this.load.audio('sfx-dishwasher', '/sounds/soundeffects/dishwasher.ogg');
    this.load.audio('sfx-dogbark', '/sounds/soundeffects/dogbark.ogg');
    this.load.audio('sfx-doorbell', '/sounds/soundeffects/doorbell.ogg');
    this.load.audio('sfx-foodchopping', '/sounds/soundeffects/foodchopping.ogg');
    this.load.audio('sfx-fridge', '/sounds/soundeffects/fridge.ogg');
    this.load.audio('sfx-glassknock', '/sounds/soundeffects/glassknock.ogg');
    this.load.audio('sfx-keyboardtyping', '/sounds/soundeffects/keyboardtyping.ogg');
    this.load.audio('sfx-shower', '/sounds/soundeffects/shower.ogg');
    this.load.audio('sfx-sleeping', '/sounds/soundeffects/sleeping.ogg');
    this.load.audio('sfx-snoring', '/sounds/soundeffects/snoring.ogg');
    this.load.audio('sfx-stairs', '/sounds/soundeffects/stairs.ogg');
    this.load.audio('sfx-toilet', '/sounds/soundeffects/toilet.ogg');
    this.load.audio('sfx-walking', '/sounds/soundeffects/walking.ogg');
    this.load.audio('sfx-wardrobe', '/sounds/soundeffects/wardrobe.ogg');
    this.load.audio('sfx-washingmachine', '/sounds/soundeffects/washingmachine.ogg');
    this.load.audio('sfx-gamesound', '/sounds/soundeffects/gamesound.mp3');
    this.load.audio('sfx-gamesoundpacman', '/sounds/soundeffects/gamesoundpacman.mp3');

    // Piano tunes
    this.load.audio('piano-0', '/sounds/piano/Quiet-Keys-at-Dusk.mp3');
    this.load.audio('piano-1', '/sounds/piano/Shadows-of-the-Keys.mp3');
    this.load.audio('piano-2', '/sounds/piano/Sunshine-Keys.mp3');
    this.load.audio('piano-3', '/sounds/piano/Tiny-Dancing-Questions.mp3');
    this.load.audio('piano-4', '/sounds/piano/Tipsy-Keys-at-Home.mp3');
    this.load.audio('piano-5', '/sounds/piano/Keys-of-Sunshine.mp3');
    this.load.audio('piano-6', '/sounds/piano/Midnight-Whispered-Reflections.mp3');
    this.load.audio('piano-7', '/sounds/piano/Quiet-Evenings-at-Home.mp3');

    // Background music
    this.load.audio('bgm-0', '/sounds/music/music/compressed/Pixel-Bounce-Adventure.mp3');
    this.load.audio('bgm-1', '/sounds/music/music/compressed/Velvet-Lantern-Lullaby.mp3');
    this.load.audio('bgm-2', '/sounds/music/music/compressed/Whispers-of-Still-Water.mp3');
    this.load.audio('bgm-3', '/sounds/music/music/compressed/Breathing-Between-Silences.mp3');
    this.load.audio('bgm-4', '/sounds/music/music/compressed/Hearth-of-Pixels.mp3');
    this.load.audio('bgm-5', '/sounds/music/music/compressed/Hearthside-Golden-Hour.mp3');
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
    this.nextBgMusicAtMs = Phaser.Math.Between(5_000, 20_000);
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
    this.tickHunger(deltaMs, time);
    this.tickIrritationRelief(time);
    this.tickSoundEffects(time);
    this.tickBackgroundMusic(time);
    this.tickTvMesh();

    this.identity.mood = tickMood(this.identity.mood, deltaMs, this.man.currentTask.type);

    if (time - this.lastProfilePushAt > PROFILE_REFRESH_INTERVAL_MS) {
      this.emitProfile();
      this.lastProfilePushAt = time;
    }

    this.applyOcclusionVisibility(this.man);
    this.applyOcclusionVisibility(this.dog);
    this.man.sprite.depth = this.getManDepth();
    this.dog.sprite.depth = this.getDogDepth();
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
    this.playSfx('sfx-doorbell', false, 0.6);
    this.time.delayedCall(2_000, () => { this.playSfx('sfx-dogbark', false, 0.5); });
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
      this.hungerCookingQueued = false;
      this.irritationReliefQueued = false;
      this.emitLog('system', `Day ${this.dayIndex} begins. Food: ${this.foodSupply}, Dog food: ${this.dogFoodSupply}`);
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

    const isSecretSleep = request.intent === 'sleep' && request.normalized.includes('prince');
    const acceptedTask: NpcTask = {
      type: isSecretSleep ? 'sleep' : request.intent,
      fromPlayerCommand: request.normalized,
      source: 'player',
      priority: INTERRUPT_PRIORITY_PLAYER,
      resumable: true,
      ...(isSecretSleep ? { remainingMs: 30_000 } : {}),
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
        this.finishManTask(this.man.currentTask, time);
      }
    }
  }

  private runTask(npc: NpcRuntime, time: number, deltaMs: number): void {
    const task = npc.currentTask.type;
    const actionAnchorForTask = this.getActionAnchorPointForTask(task);

    // Redirect standalone use_cooker to full cooking chain starting from fridge
    if (task === 'use_cooker' && npc.currentTask.fromPlayerCommand !== 'cooking_chain' && npc.performUntilMs === 0) {
      if (this.foodSupply <= 0) {
        this.emitLog('man', `${this.identity.name} wants to cook but there is no food!`);
        this.finishManTask();
        return;
      }
      npc.currentTask = { type: 'use_fridge', source: npc.currentTask.source, priority: npc.currentTask.priority ?? 50, resumable: false, fromPlayerCommand: 'cooking_chain' };
      npc.pendingTargetCell = null;
      npc.path = [];
      return;
    }

    if (task === 'idle' || task === 'idle_stand') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        if (task === 'idle_stand' && npc.id === 'man') {
          this.applyNpcScaleForTexture(npc, this.resolveTexture('man-idle-stand', 'man-walk-down'));
          npc.sprite.play('man-anim-idle-stand', true);
        } else {
          this.playNpcIdle(npc);
        }
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
      const bedAnchor = this.actionAnchors['lay_bed'];
      const bedTarget = this.getActionAnchorTargetCell('lay_bed');
      if (bedTarget && npc.performUntilMs === 0) {
        const reached = this.moveNpcToCell(npc, bedTarget, time);
        if (!reached) return;
      }
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        this.applyNpcScaleForTexture(npc, 'man-walk-down');
        npc.sprite.play('man-anim-sleep', true);
        this.startSleepSoundTracking(time);
      }
      if (bedAnchor) {
        npc.sprite.setPosition(bedAnchor.x, this.toRenderY(bedAnchor.y, npc.id));
        if (bedAnchor.foreground && npc.performUntilMs > 0) {
          npc.sprite.depth = this.toLogicalY(npc.sprite.y, npc.id) + 200;
        }
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

    if (task === 'dance') {
      if (npc.performUntilMs === 0) {
        npc.performUntilMs = time + this.resolveTaskDuration(npc.currentTask);
        this.applyNpcScaleForTexture(npc, this.resolveTexture('man-dance', 'man-use-object'));
        npc.sprite.play('man-anim-dance', true);
      }
      if (time >= npc.performUntilMs) {
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
      if (task === 'sit_chair' || task === 'sit_sofa') {
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
        this.applyNpcScaleForTexture(npc, 'man-walk-down');
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
        task === 'collect_washing' ||
        task === 'use_tv'
      ) {
        this.applyNpcScaleForTexture(npc, 'man-use-object');
        npc.sprite.play('man-anim-use-object', true);
      }
      if (task === 'use_tv') {
        this.showTvVideo();
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
        return 60_000;
      case 'type_letter':
        return between(30_000, 95_000);
      case 'use_running_machine':
        return between(30_000, 60_000);
      case 'take_shower':
        return between(20_000, 45_000);
      case 'use_toilet':
        return between(20_000, 35_000);
      case 'use_fridge':
        return 10_000;
      case 'use_kitchen_sink':
        return between(20_000, 40_000);
      case 'use_washing_machine':
        return 10_000;
      case 'use_dishwasher':
        return 10_000;
      case 'open_kitchen_cupboard':
        return between(20_000, 36_000);
      case 'use_bookcase':
        return between(20_000, 45_000);
      case 'use_kitchen_worktop':
        return 10_000;
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
      case 'use_tv':
        return between(8_000, 15_000);
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
      case 'use_tv':
        return this.getActionAnchorTargetCell('use_tv');
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
      task === 'use_tv' ||
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
    this.manWalkDirection = null;
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

    // Cooking chain: use_fridge → use_kitchen_worktop → use_cooker → eating_food → use_dishwasher
    if (task.type === 'use_fridge' && task.fromPlayerCommand === 'cooking_chain') {
      this.hideInteractiveObjectsForTask('use_fridge');
      this.emitLog('man', `${this.identity.name} got ingredients and moves to the worktop.`);
      this.enqueueTask(
        { type: 'use_kitchen_worktop', source: 'system', priority: 50, resumable: false, fromPlayerCommand: 'cooking_chain' },
        true
      );
    } else if (task.type === 'use_fridge') {
      this.hideInteractiveObjectsForTask('use_fridge');
    }

    if (task.type === 'use_kitchen_worktop' && task.fromPlayerCommand === 'cooking_chain') {
      this.emitLog('man', `${this.identity.name} finished preparing and starts cooking.`);
      this.enqueueTask(
        { type: 'use_cooker', source: 'system', priority: 50, resumable: false, fromPlayerCommand: 'cooking_chain' },
        true
      );
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
      this.foodSupply = Math.max(0, this.foodSupply - FOOD_PER_MEAL);
      this.manHunger = Math.max(0, this.manHunger - 0.6);
      this.hungerCookingQueued = false;
      if (this.manIsSick) {
        this.manIsSick = false;
        this.emitLog('system', `${this.identity.name} feels much better after eating.`);
      }
      this.emitLog('man', `${this.identity.name} finished eating and goes to wash up. (Food: ${this.foodSupply})`);
      this.enqueueTask(
        { type: 'use_dishwasher', source: 'system', priority: 50, resumable: false, remainingMs: 10_000 },
        true
      );
    }

    if (task.type === 'use_toilet') {
      this.playSfx('sfx-toilet', false, 0.4);
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

    // Post-delivery chain: door → cupboard or fridge
    if (task.type === 'door_delivery') {
      this.foodSupply += FOOD_PER_DELIVERY;
      this.dogFoodSupply += DOG_FOOD_PER_DELIVERY;
      this.emitLog('system', `Delivery received! Food: ${this.foodSupply}, Dog food: ${this.dogFoodSupply}`);
      const goToFridge = Math.random() < 0.5;
      if (goToFridge) {
        this.emitLog('man', `${this.identity.name} takes the delivery to the fridge.`);
        this.enqueueTask(
          { type: 'use_fridge', source: 'system', priority: 50, resumable: false },
          true
        );
      } else {
        this.emitLog('man', `${this.identity.name} takes the delivery to the cupboard.`);
        this.enqueueTask(
          { type: 'open_kitchen_cupboard', source: 'system', priority: 50, resumable: false },
          true
        );
      }
    }

    // TV ↔ settee loop: use_tv (turn on) → sit_settee (watch 2 min) → use_tv (turn off)
    if (task.type === 'use_tv' && task.fromPlayerCommand !== 'tv_turn_off') {
      // TV just turned on — keep video playing, go sit on settee to watch
      this.emitLog('man', `${this.identity.name} goes to sit on the settee.`);
      this.enqueueTask(
        { type: 'sit_settee', source: 'system', priority: 50, resumable: false, remainingMs: 120_000, fromPlayerCommand: 'tv_loop' },
        true
      );
    }

    if (task.type === 'use_tv' && task.fromPlayerCommand === 'tv_turn_off') {
      // TV turn-off visit — stop the video
      this.hideTvVideo();
    }

    if (task.type === 'sit_settee' && task.fromPlayerCommand === 'tv_loop') {
      this.emitLog('man', `${this.identity.name} gets up to turn off the TV.`);
      this.enqueueTask(
        { type: 'use_tv', source: 'system', priority: 50, resumable: false, fromPlayerCommand: 'tv_turn_off' },
        true
      );
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
    if (npc.id === 'man') {
      this.manWalkDirection = direction;
    }

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
    this.manWalkDirection = null;
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
      this.applyNpcScaleForTexture(this.man, 'man-walk-down');
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
      this.applyNpcScaleForTexture(this.man, 'man-walk-down');
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
      task === 'collect_washing' ||
      task === 'use_tv'
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

  private tickHunger(deltaMs: number, _time: number): void {
    const minuteFactor = deltaMs / 60_000;

    // Man hunger increases over time
    this.manHunger = Math.min(1, this.manHunger + MAN_HUNGER_RATE_PER_MIN * minuteFactor);

    // Dog hunger increases over time
    this.dogHunger = Math.min(1, this.dogHunger + DOG_HUNGER_RATE_PER_MIN * minuteFactor);

    // Man becomes sick when hunger is too high
    if (this.manHunger >= MAN_HUNGER_SICK_THRESHOLD && !this.manIsSick) {
      this.manIsSick = true;
      this.emitLog('system', `${this.identity.name} is feeling sick from hunger!`);
    }

    // Man auto-cooks when hungry and food is available
    if (
      this.manHunger >= MAN_HUNGER_COOK_THRESHOLD &&
      !this.hungerCookingQueued &&
      this.foodSupply > 0 &&
      this.man.currentTask.type !== 'eating_food' &&
      this.man.currentTask.type !== 'use_cooker' &&
      this.man.currentTask.type !== 'use_kitchen_worktop' &&
      this.man.currentTask.fromPlayerCommand !== 'cooking_chain'
    ) {
      this.hungerCookingQueued = true;
      this.emitLog('system', `${this.identity.name} is getting hungry and decides to cook.`);
      this.enqueueTask(
        { type: 'use_fridge', source: 'system', priority: 60, resumable: false, fromPlayerCommand: 'cooking_chain' },
        true
      );
    }

    // Dog auto-eats when hungry and dog food is available
    if (
      this.dogHunger >= DOG_HUNGER_EAT_THRESHOLD &&
      this.dogFoodSupply > 0 &&
      this.dog.performUntilMs === 0 &&
      this.dog.currentTask.type !== 'sleep'
    ) {
      const eatCell = this.getDogAnchorTargetCell('dog_eating');
      if (eatCell && this.dog.currentTask.type === 'wander') {
        this.dog.currentTask = { type: 'idle' };
        this.dog.pendingTargetCell = eatCell;
      }
    }
  }

  private tickIrritationRelief(_time: number): void {
    if (this.identity.mood.irritation < IRRITATION_AUTO_RELIEF_THRESHOLD) {
      this.irritationReliefQueued = false;
      return;
    }

    if (this.irritationReliefQueued) {
      return;
    }

    // Don't interrupt if already doing a relief activity
    const current = this.man.currentTask.type;
    if (current === 'play_piano' || current === 'use_computer' || current === 'use_tv') {
      return;
    }

    const reliefOptions: TaskType[] = [];
    if (this.isTaskAvailable('play_piano')) reliefOptions.push('play_piano');
    if (this.isTaskAvailable('use_computer')) reliefOptions.push('use_computer');
    if (this.isTaskAvailable('use_tv')) reliefOptions.push('use_tv');

    if (reliefOptions.length === 0) {
      return;
    }

    this.irritationReliefQueued = true;
    const chosen = reliefOptions[Math.floor(Math.random() * reliefOptions.length)];
    this.emitLog('system', `${this.identity.name} is feeling irritated and decides to ${textForTask(chosen)}.`);
    this.enqueueTask(
      { type: chosen, source: 'system', priority: 55, resumable: false },
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
    // Always scale relative to walk sprite so the dog stays a consistent size
    this.applyNpcScaleForTexture(this.dog, 'dog-walk-down');
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

    // One-shot tasks: only run once per beat, then idle for the rest
    if (task === 'use_running_machine' && !beatChanged) {
      task = 'idle_stand';
    }

    const lifestyle = this.identity.lifestyle;
    if (task === 'play_piano' && this.identity.personality.playfulness > 0.66 && beatRoll < 0.33) {
      task = 'dance';
    } else if (task === 'use_computer' && this.identity.personality.diligence > 0.7 && beatRoll < 0.35) {
      task = 'type_letter';
    } else if (task === 'wander') {
      const canPetDog = time >= this.dogInteractionCooldownUntilMs && this.isTaskAvailable('pet_dog');
      task = weightedChoiceByRoll<TaskType>(
        [
          { value: 'idle_stand', weight: 10 },
          { value: 'wander', weight: 10 },
          { value: 'sit_chair', weight: 4 + (lifestyle?.sedentary ?? 0.3) * 10 },
          { value: 'play_piano', weight: 2 + (lifestyle?.lovesPiano ?? 0.5) * 12 },
          { value: 'use_computer', weight: 2 + (lifestyle?.lovesGaming ?? 0.5) * 10 },
          { value: 'use_tv', weight: 2 + (lifestyle?.lovesTV ?? 0.3) * 10 },
          { value: 'use_bookcase', weight: 1 + (lifestyle?.lovesReading ?? 0.3) * 8 },
          { value: 'take_shower', weight: 1 + (lifestyle?.hygiene ?? 0.5) * 5 },
          { value: 'use_running_machine', weight: 1 + (lifestyle?.lovesExercise ?? 0.3) * 8 },
          { value: 'pet_dog', weight: canPetDog ? 8 : 0 },
        ],
        this.getDeterministicBeatRoll(beatIndex, 3)
      );
    }

    const resolvedTask = this.resolveTaskWithAvailability(task);
    if (resolvedTask !== task && beatChanged) {
      this.emitLog('system', `Routine fallback: ${textForTask(task)} unavailable, using ${textForTask(resolvedTask)}.`);
    }

    // Wardrobe before sleep: queue wardrobe first, then sleep/lay_bed
    if (resolvedTask === 'sleep' && beatChanged && this.isTaskAvailable('use_wardrobe')) {
      this.man.currentTask = { type: 'use_wardrobe', source: 'routine', priority: 10, resumable: false };
      this.man.performUntilMs = 0;
      this.enqueueTask({ type: resolvedTask, source: 'routine', priority: 10, resumable: true });
      return;
    }

    // Wardrobe after wake: queue wardrobe when the morning starts
    if (resolvedTask === 'idle_stand' && beatChanged && beatIndex === 0 && this.isTaskAvailable('use_wardrobe')) {
      this.man.currentTask = { type: 'use_wardrobe', source: 'routine', priority: 10, resumable: false };
      this.man.performUntilMs = 0;
      this.enqueueTask({ type: resolvedTask, source: 'routine', priority: 10, resumable: true });
      return;
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
      this.playSfx('sfx-glassknock', false, 0.5);
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
      const dogSleepChance = DOG_SLEEP_CHANCE + (this.identity.dog?.lovesSleep ?? 0.5) * 0.15;
      const dogEatChance = DOG_EAT_CHANCE + (this.identity.dog?.lovesFood ?? 0.5) * 0.1;

      // Try to nap at anchor
      if (roll < dogSleepChance) {
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
      if (roll < dogSleepChance + dogEatChance && this.dogFoodSupply > 0) {
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
            this.dogFoodSupply = Math.max(0, this.dogFoodSupply - DOG_FOOD_PER_MEAL);
            this.dogHunger = Math.max(0, this.dogHunger - 0.5);
            this.dog.performUntilMs = time + DOG_EAT_DURATION_MS;
            this.playDogEating();
            this.emitLog('system', `The dog eats some food. (Dog food: ${this.dogFoodSupply})`);
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
      if (this.dogFoodSupply <= 0) {
        this.dog.currentTask = { type: 'wander' };
        this.dog.pendingTargetCell = null;
        this.playDogIdle();
        return;
      }
      const eatCell = this.dog.pendingTargetCell;
      const reached = this.moveNpcToCell(this.dog, eatCell, time);
      if (reached) {
        const anchor = this.actionAnchors['dog_eating'];
        if (anchor) {
          this.dog.sprite.setPosition(anchor.x, this.toRenderY(anchor.y, 'dog'));
        }
        this.dogFoodSupply = Math.max(0, this.dogFoodSupply - DOG_FOOD_PER_MEAL);
        this.dogHunger = Math.max(0, this.dogHunger - 0.5);
        this.dog.performUntilMs = time + DOG_EAT_DURATION_MS;
        this.playDogEating();
        this.emitLog('system', `The dog eats some food. (Dog food: ${this.dogFoodSupply})`);
      }
      return;
    }

    // Default wandering behavior
    if (this.dog.path.length === 0) {
      // Chance to idle in place before wandering again (lower energy dogs idle more)
      const dogIdleChance = 0.3 + (1 - (this.identity.dog?.energy ?? 0.5)) * 0.2;
      if (this.dog.performUntilMs === 0 && Math.random() < dogIdleChance) {
        this.dog.performUntilMs = time + Phaser.Math.Between(8_000, 25_000);
        this.playDogIdle();
        return;
      }
      if (this.dog.performUntilMs > 0) {
        if (time < this.dog.performUntilMs) {
          return;
        }
        this.dog.performUntilMs = 0;
      }

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

  private getDogDepth(): number {
    const baseDepth = this.toLogicalY(this.dog.sprite.y, 'dog');
    let isForeground = false;
    if (this.dog.performUntilMs > 0 && this.dog.path.length === 0) {
      const anchorKey: ActionAnchorKey | null =
        this.dog.currentTask.type === 'sleep' ? 'dog_sleeping' : 'dog_eating';
      const anchor = this.actionAnchors[anchorKey];
      if (anchor && anchor.foreground) {
        isForeground = true;
      }
    }
    // Small boost to render in front of the object, but not so large it overrides
    // normal Y-based ordering with the other NPC
    return isForeground ? baseDepth + 200 : baseDepth;
  }

  private getManDepth(): number {
    const baseDepth = this.toLogicalY(this.man.sprite.y, 'man');
    const isForegroundInteraction =
      this.man.performUntilMs > 0 &&
      this.man.path.length === 0 &&
      this.isForegroundInteractionTask(this.man.currentTask.type);
    // Small boost to render in front of the object, but not so large it overrides
    // normal Y-based ordering with the other NPC
    return isForegroundInteraction ? baseDepth + 200 : baseDepth;
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

  // ─── Sound Effects ──────────────────────────────────────────────

  private playSfx(key: string, loop = false, volume = 0.5, isMusic = false): Phaser.Sound.BaseSound | null {
    try {
      const scaledVolume = volume * (isMusic ? this.musicVolume : this.sfxVolume);
      const sound = this.sound.add(key, { loop, volume: scaledVolume });
      // Store base volume and category so we can rescale when sliders change
      (sound as unknown as { _baseVol: number; _isMusic: boolean })._baseVol = volume;
      (sound as unknown as { _baseVol: number; _isMusic: boolean })._isMusic = isMusic;
      sound.play();
      return sound;
    } catch {
      return null;
    }
  }

  private stopSfx(sound: Phaser.Sound.BaseSound | null): null {
    if (sound && (sound as Phaser.Sound.WebAudioSound).isPlaying) {
      sound.stop();
      sound.destroy();
    }
    return null;
  }

  private updateSfxVolume(sound: Phaser.Sound.BaseSound | null): void {
    if (!sound) return;
    const meta = sound as unknown as { _baseVol?: number; _isMusic?: boolean };
    const base = meta._baseVol ?? 0.5;
    const isMusic = meta._isMusic ?? false;
    const scaled = base * (isMusic ? this.musicVolume : this.sfxVolume);
    (sound as Phaser.Sound.WebAudioSound).setVolume(scaled);
  }

  private tickSoundEffects(time: number): void {
    const task = this.man.currentTask.type;
    const isPerforming = this.man.performUntilMs > 0;

    // Walking sound: plays while man moves left/right
    if (this.man.path.length > 0 && this.manWalkDirection !== null) {
      if (this.manWalkDirection === 'left' || this.manWalkDirection === 'right') {
        if (!this.sfxWalking || !(this.sfxWalking as Phaser.Sound.WebAudioSound).isPlaying) {
          this.sfxWalking = this.playSfx('sfx-walking', true, 0.3);
        }
        this.sfxStairs = this.stopSfx(this.sfxStairs);
      } else if (this.manWalkDirection === 'up' || this.manWalkDirection === 'down') {
        // Stairs sound: plays while man walks up/down
        if (!this.sfxStairs || !(this.sfxStairs as Phaser.Sound.WebAudioSound).isPlaying) {
          this.sfxStairs = this.playSfx('sfx-stairs', true, 0.35);
        }
        this.sfxWalking = this.stopSfx(this.sfxWalking);
      }
    } else {
      this.sfxWalking = this.stopSfx(this.sfxWalking);
      this.sfxStairs = this.stopSfx(this.sfxStairs);
    }

    // Shower sound: loops while man is showering
    if (task === 'take_shower' && isPerforming) {
      if (!this.sfxShower || !(this.sfxShower as Phaser.Sound.WebAudioSound).isPlaying) {
        this.sfxShower = this.playSfx('sfx-shower', true, 0.4);
      }
    } else {
      this.sfxShower = this.stopSfx(this.sfxShower);
    }

    // Sleeping sound: loops while man is sleeping; random snoring
    if ((task === 'sleep' || task === 'lay_bed') && isPerforming) {
      if (!this.sfxSleeping || !(this.sfxSleeping as Phaser.Sound.WebAudioSound).isPlaying) {
        this.sfxSleeping = this.playSfx('sfx-sleeping', true, 0.3);
      }
      // Random snoring
      if (time >= this.nextSnoreAtMs) {
        this.playSfx('sfx-snoring', false, 0.25);
        this.nextSnoreAtMs = time + Phaser.Math.Between(8_000, 20_000);
      }
      // Alarm clock 2 seconds before waking
      if (!this.alarmClockScheduled && this.man.performUntilMs > 0 && this.man.performUntilMs - time <= 2_000) {
        this.alarmClockScheduled = true;
        this.playSfx('sfx-alarmclock', false, 0.6);
      }
    } else {
      this.sfxSleeping = this.stopSfx(this.sfxSleeping);
      if (task !== 'sleep' && task !== 'lay_bed') {
        this.alarmClockScheduled = false;
        this.nextSnoreAtMs = 0;
      }
    }

    // Piano sound: plays while man plays piano, stops when he leaves
    const isPianoTask = (task === 'play_piano' || task === 'play_another_song') && isPerforming;
    if (isPianoTask) {
      if (!this.sfxPiano || !(this.sfxPiano as Phaser.Sound.WebAudioSound).isPlaying) {
        const PIANO_TRACK_COUNT = 8;
        let pick = Math.floor(Math.random() * PIANO_TRACK_COUNT);
        if (pick === this.lastPianoTrackIndex) {
          pick = (pick + 1) % PIANO_TRACK_COUNT;
        }
        this.lastPianoTrackIndex = pick;
        this.sfxPiano = this.playSfx(`piano-${pick}`, false, 0.4, true);
      }
    } else {
      this.sfxPiano = this.stopSfx(this.sfxPiano);
    }

    // Game sound: plays while man uses computer (not typing a letter)
    if ((task === 'use_computer') && isPerforming) {
      if (!this.sfxGameSound || !(this.sfxGameSound as Phaser.Sound.WebAudioSound).isPlaying) {
        // Randomly pick between gamesound and gamesoundpacman
        const gameKey = Math.random() < 0.5 ? 'sfx-gamesound' : 'sfx-gamesoundpacman';
        this.sfxGameSound = this.playSfx(gameKey, true, 0.25);
      }
    } else {
      this.sfxGameSound = this.stopSfx(this.sfxGameSound);
    }

    // Keyboard typing: plays while man types a letter or uses computer (not game — but use_computer IS game)
    // Actually per user spec: keyboardtyping triggers when man types a letter OR when using computer and not playing a game
    // Since use_computer is game play, keyboardtyping only applies to type_letter
    // But the user also said it triggers when "the man types a letter" — so we treat type_letter as keyboard typing
    if (task === 'type_letter' && isPerforming) {
      if (this.lastSfxTaskType !== 'type_letter') {
        this.playSfx('sfx-keyboardtyping', false, 0.35);
      }
    }

    // Looping interaction sounds: fridge, dishwasher, kitchen worktop — stop when task ends
    const loopingInteractionTask = task === 'use_fridge' || task === 'use_dishwasher' || task === 'use_kitchen_worktop';
    if (loopingInteractionTask && isPerforming) {
      if (!this.sfxInteraction || !(this.sfxInteraction as Phaser.Sound.WebAudioSound).isPlaying) {
        const sfxKey = task === 'use_fridge' ? 'sfx-fridge'
          : task === 'use_dishwasher' ? 'sfx-dishwasher'
          : 'sfx-foodchopping';
        this.sfxInteraction = this.playSfx(sfxKey, true, 0.5);
      }
    } else {
      this.sfxInteraction = this.stopSfx(this.sfxInteraction);
    }

    // One-shot sound triggers when starting a new task performance
    if (isPerforming && this.lastSfxTaskType !== task) {
      switch (task) {
        case 'use_cooker':
          this.playSfx('sfx-cooker', false, 0.5);
          break;
        case 'open_kitchen_cupboard':
          this.playSfx('sfx-cupboard', false, 0.5);
          break;
        case 'use_wardrobe':
          this.playSfx('sfx-wardrobe', false, 0.5);
          break;
        case 'use_washing_machine':
          this.playSfx('sfx-washingmachine', false, 0.5);
          break;
      }
    }

    this.lastSfxTaskType = isPerforming ? task : null;

    // Update volumes on all active looping sounds in real-time
    this.updateSfxVolume(this.sfxWalking);
    this.updateSfxVolume(this.sfxStairs);
    this.updateSfxVolume(this.sfxShower);
    this.updateSfxVolume(this.sfxSleeping);
    this.updateSfxVolume(this.sfxGameSound);
    this.updateSfxVolume(this.sfxInteraction);
    this.updateSfxVolume(this.sfxPiano);
  }

  private showTvVideo(): void {
    if (this.tvVideoPlaying) return;

    const coordinateScale = getLayoutToWorldScale();

    // Read quad points from layout JSON (set via House-Layout-Editor)
    const layoutNav = (houseLayout as { navigation?: { tv_screen_quad?: Array<{ x: number; y: number } | null> } }).navigation;
    const quad = layoutNav?.tv_screen_quad;

    if (quad && quad.length === 4 && quad.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
      // Scale all quad points from layout space to world space
      const pts = quad.map((p) => ({
        x: p!.x * coordinateScale.x,
        y: p!.y * coordinateScale.y,
      }));

      // Sort into TL, TR, BL, BR by position
      const sorted = [...pts].sort((a, b) => a.x - b.x);
      const leftPair = sorted.slice(0, 2).sort((a, b) => a.y - b.y);
      const rightPair = sorted.slice(2, 4).sort((a, b) => a.y - b.y);
      const tl = leftPair[0];
      const bl = leftPair[1];
      const tr = rightPair[0];
      const br = rightPair[1];

      // Bounding box
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const bboxW = Math.ceil(maxX - minX);
      const bboxH = Math.ceil(maxY - minY);

      const tvDepth = this.findTvSpriteDepth();

      try {
        // Hidden video for playback + audio
        const video = this.add.video(0, 0, 'tv-movie');
        video.setVisible(false);
        video.setVolume(this.musicVolume * 0.4);
        video.play(true);
        this.tvVideo = video;

        // Canvas texture sized to the bounding box of the quad
        const canvasTex = this.textures.createCanvas('tv-canvas', bboxW, bboxH);
        this.tvCanvasTexture = canvasTex;

        // Store quad corners relative to the bounding box origin for the canvas draw
        (this as unknown as { _tvQuadLocal: { tl: { x: number; y: number }; tr: { x: number; y: number }; bl: { x: number; y: number }; br: { x: number; y: number } } })._tvQuadLocal = {
          tl: { x: tl.x - minX, y: tl.y - minY },
          tr: { x: tr.x - minX, y: tr.y - minY },
          bl: { x: bl.x - minX, y: bl.y - minY },
          br: { x: br.x - minX, y: br.y - minY },
        };

        // Display as a regular image, positioned at bbox top-left (origin 0,0)
        const img = this.add.image(minX, minY, 'tv-canvas');
        img.setOrigin(0, 0);
        img.setDepth(tvDepth + 1);
        this.tvMesh = img as unknown as Phaser.GameObjects.Mesh;

        this.tvVideoPlaying = true;
      } catch {
        // Video playback not supported or file missing
      }
      return;
    }

    // Fallback: estimate screen area from TV sprite dimensions
    const layoutObjects = (houseLayout.objects as LayoutPlacedObject[]) || [];
    const tvObj = layoutObjects.find((o) => o.type.startsWith('tv_'));
    if (!tvObj) return;

    const objectAnchor = getLayoutObjectAnchor();
    const tvRenderX = tvObj.x * coordinateScale.x;
    const tvRenderY = tvObj.y * coordinateScale.y;
    const tvScale = typeof tvObj.scale === 'number' ? tvObj.scale : 1;

    const textureKey = `${LAYOUT_OBJECT_TEXTURE_PREFIX}${tvObj.type}`;
    if (!this.textures.exists(textureKey)) return;
    const source = this.textures.get(textureKey).getSourceImage() as HTMLImageElement;
    const texW = source.width * tvScale * coordinateScale.x;
    const texH = source.height * tvScale * coordinateScale.y;

    const screenLeft = tvRenderX - texW * objectAnchor.x + texW * 0.12;
    const screenTop = tvRenderY - texH * objectAnchor.y + texH * 0.06;
    const screenW = texW * 0.76;
    const screenH = texH * 0.50;

    try {
      const video = this.add.video(screenLeft + screenW / 2, screenTop + screenH / 2, 'tv-movie');
      video.setDisplaySize(screenW, screenH);
      video.setDepth(tvRenderY + 1);
      video.setVolume(this.musicVolume * 0.4);
      video.play(true);
      this.tvVideo = video;
      this.tvVideoPlaying = true;
    } catch {
      // Video playback not supported or file missing
    }
  }

  private findTvSpriteDepth(): number {
    const layoutObjects = (houseLayout.objects as LayoutPlacedObject[]) || [];
    const tvObj = layoutObjects.find((o) => o.type.startsWith('tv_'));
    if (!tvObj) return 500;
    const coordinateScale = getLayoutToWorldScale();
    const renderY = tvObj.y * coordinateScale.y;
    const zIndex = tvObj.zIndex ?? 0;
    return renderY + zIndex * 64;
  }

  private tickTvMesh(): void {
    if (!this.tvMesh || !this.tvVideo || !this.tvCanvasTexture) return;
    const htmlVideo = this.tvVideo.video;
    if (!htmlVideo || htmlVideo.readyState < 2) return;

    const quadLocal = (this as unknown as { _tvQuadLocal?: { tl: { x: number; y: number }; tr: { x: number; y: number }; bl: { x: number; y: number }; br: { x: number; y: number } } })._tvQuadLocal;
    if (!quadLocal) return;

    const { tl, tr, bl } = quadLocal;
    const ctx = this.tvCanvasTexture.context;
    const w = this.tvCanvasTexture.width;
    const h = this.tvCanvasTexture.height;

    ctx.clearRect(0, 0, w, h);

    // Affine transform maps unit square to parallelogram defined by TL, TR, BL:
    // (0,0)->TL, (1,0)->TR, (0,1)->BL
    // setTransform(a, b, c, d, e, f) where:
    //   a = dx per source-x, b = dy per source-x
    //   c = dx per source-y, d = dy per source-y
    //   e = translate-x, f = translate-y
    const srcW = htmlVideo.videoWidth || 1;
    const srcH = htmlVideo.videoHeight || 1;

    const ax = (tr.x - tl.x) / srcW;
    const ay = (tr.y - tl.y) / srcW;
    const bx = (bl.x - tl.x) / srcH;
    const by = (bl.y - tl.y) / srcH;

    ctx.setTransform(ax, ay, bx, by, tl.x, tl.y);
    ctx.drawImage(htmlVideo, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.tvCanvasTexture.refresh();
  }

  private hideTvVideo(): void {
    if (this.tvMesh) {
      this.tvMesh.destroy();
      this.tvMesh = null;
    }
    if (this.tvCanvasTexture) {
      this.textures.remove('tv-canvas');
      this.tvCanvasTexture = null;
    }
    if (this.tvVideo) {
      this.tvVideo.stop();
      this.tvVideo.destroy();
      this.tvVideo = null;
    }
    this.tvVideoPlaying = false;
  }

  private startSleepSoundTracking(time: number): void {
    this.alarmClockScheduled = false;
    this.nextSnoreAtMs = time + Phaser.Math.Between(5_000, 15_000);
  }

  private tickBackgroundMusic(time: number): void {
    const task = this.man.currentTask.type;
    const isPerforming = this.man.performUntilMs > 0;
    const shouldDuck = isPerforming && (
      task === 'play_piano' || task === 'play_another_song' || task === 'use_computer'
    );

    // Fade out when piano or gaming is active
    if (shouldDuck && this.bgMusic && !this.bgMusicFadingOut) {
      this.bgMusicFadingOut = true;
      const webSound = this.bgMusic as Phaser.Sound.WebAudioSound;
      if (webSound.isPlaying) {
        this.tweens.add({
          targets: this.bgMusic,
          volume: 0,
          duration: 2_000,
          onComplete: () => {
            this.bgMusic = this.stopSfx(this.bgMusic);
            this.bgMusicFadingOut = false;
          },
        });
      } else {
        this.bgMusic = this.stopSfx(this.bgMusic);
        this.bgMusicFadingOut = false;
      }
      return;
    }

    // While ducking activity is happening, don't start new music
    if (shouldDuck) {
      this.nextBgMusicAtMs = 0;
      return;
    }

    // Schedule next track after ducking ends
    if (this.nextBgMusicAtMs === 0 && !this.bgMusicFadingOut) {
      this.nextBgMusicAtMs = time + Phaser.Math.Between(10_000, 40_000);
    }

    // If current track finished, schedule silence gap before next
    if (this.bgMusic && !(this.bgMusic as Phaser.Sound.WebAudioSound).isPlaying && !this.bgMusicFadingOut) {
      this.bgMusic.destroy();
      this.bgMusic = null;
      this.nextBgMusicAtMs = time + Phaser.Math.Between(15_000, 60_000);
    }

    // Start a new track when it's time
    if (!this.bgMusic && !this.bgMusicFadingOut && this.nextBgMusicAtMs > 0 && time >= this.nextBgMusicAtMs) {
      let pick = Math.floor(Math.random() * LifeSimScene.BG_MUSIC_COUNT);
      if (pick === this.lastBgMusicIndex) {
        pick = (pick + 1) % LifeSimScene.BG_MUSIC_COUNT;
      }
      this.lastBgMusicIndex = pick;
      this.bgMusic = this.playSfx(`bgm-${pick}`, false, 0.2, true);
      this.nextBgMusicAtMs = 0;
    }

    // Keep background music volume in sync with slider
    this.updateSfxVolume(this.bgMusic);
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
