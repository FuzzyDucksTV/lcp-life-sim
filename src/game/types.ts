export type CellKey = `${number},${number}`;

export interface Vec2 {
  x: number;
  y: number;
}

export type NpcId = 'man' | 'dog';

export interface Personality {
  obedience: number;
  playfulness: number;
  diligence: number;
  sociability: number;
}

export interface MoodState {
  energy: number;
  irritation: number;
  focus: number;
  warmth: number;
}

export interface ManIdentity {
  name: string;
  appearanceSeed: number;
  personality: Personality;
  mood: MoodState;
  createdAt: string;
}

export type TaskType =
  | 'idle'
  | 'idle_stand'
  | 'wander'
  | 'sleep'
  | 'pet_dog'
  | 'sit_chair'
  | 'sit_sofa'
  | 'sit_settee'
  | 'sit_computer_desk'
  | 'sit_piano'
  | 'lay_bed'
  | 'take_shower'
  | 'use_toilet'
  | 'use_fridge'
  | 'use_kitchen_sink'
  | 'use_washing_machine'
  | 'use_dishwasher'
  | 'open_kitchen_cupboard'
  | 'use_bookcase'
  | 'use_kitchen_worktop'
  | 'use_cooker'
  | 'use_wardrobe'
  | 'use_computer'
  | 'use_running_machine'
  | 'play_piano'
  | 'play_another_song'
  | 'dance'
  | 'type_letter'
  | 'eating_food'
  | 'door_delivery';

export interface NpcTask {
  type: TaskType;
  targetCell?: CellKey;
  dueAtMs?: number;
  fromPlayerCommand?: string;
  source?: 'routine' | 'player' | 'system' | 'resume';
  priority?: number;
  remainingMs?: number;
  resumable?: boolean;
}

export interface SimCommand {
  raw: string;
  normalized: string;
  tokens: string[];
  requiresPlease: boolean;
  isUnderstood: boolean;
  intent: TaskType | null;
  feedback: string;
}

export interface SaveSnapshot {
  version: 1;
  manIdentity: ManIdentity;
  dayIndex: number;
}

export interface CommandLogEntry {
  source: 'system' | 'player' | 'man';
  text: string;
  atMs: number;
}
