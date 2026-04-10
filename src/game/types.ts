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

export interface LifestyleTraits {
  lovesGaming: number;      // 0-1 how much he likes computer games
  lovesPiano: number;       // 0-1 how much he enjoys piano
  lovesTV: number;          // 0-1 how much he watches TV
  lovesReading: number;     // 0-1 bookcase usage
  lovesExercise: number;    // 0-1 running machine frequency
  lovesFood: number;        // 0-1 how much he loves cooking/eating
  hygiene: number;          // 0-1 shower frequency
  sedentary: number;        // 0-1 sitting in chair frequency
}

export interface DogPersonality {
  name: string;
  lovesFood: number;        // 0-1 eats more often
  lovesSleep: number;       // 0-1 sleeps more often
  energy: number;           // 0-1 how active/wandery
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
  lifestyle: LifestyleTraits;
  dog: DogPersonality;
  backstory: string;
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
  | 'collect_washing'
  | 'use_tv'
  | 'turn_off_tv'
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
