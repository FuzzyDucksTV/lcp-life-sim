import type { ManIdentity, MoodState, Personality } from '../types';

const MAN_NAMES = [
  'Adam', 'Alex', 'Arlo', 'Ben', 'Carl', 'Colin', 'Darren', 'Eli', 'Evan', 'Felix',
  'Gabe', 'Hugo', 'Ian', 'Jules', 'Kai', 'Leo', 'Liam', 'Mason', 'Milo', 'Noah',
  'Oliver', 'Owen', 'Paul', 'Quinn', 'Reed', 'Sam', 'Theo', 'Toby', 'Victor', 'Wes',
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createRandomPersonality(): Personality {
  const archetypes: Array<Partial<Personality>> = [
    { obedience: 0.78, playfulness: 0.35, diligence: 0.84, sociability: 0.62 },
    { obedience: 0.42, playfulness: 0.86, diligence: 0.38, sociability: 0.78 },
    { obedience: 0.55, playfulness: 0.55, diligence: 0.55, sociability: 0.55 },
    { obedience: 0.67, playfulness: 0.71, diligence: 0.46, sociability: 0.44 },
  ];

  const archetype = archetypes[Math.floor(Math.random() * archetypes.length)];

  return {
    obedience: clamp01((archetype.obedience ?? 0.5) + randomFloat(-0.15, 0.15)),
    playfulness: clamp01((archetype.playfulness ?? 0.5) + randomFloat(-0.15, 0.15)),
    diligence: clamp01((archetype.diligence ?? 0.5) + randomFloat(-0.15, 0.15)),
    sociability: clamp01((archetype.sociability ?? 0.5) + randomFloat(-0.15, 0.15)),
  };
}

function createStartingMood(personality: Personality): MoodState {
  return {
    energy: clamp01(0.68 + personality.diligence * 0.2 + randomFloat(-0.1, 0.1)),
    irritation: clamp01(0.2 + (1 - personality.obedience) * 0.15 + randomFloat(-0.08, 0.08)),
    focus: clamp01(0.5 + personality.diligence * 0.3 + randomFloat(-0.08, 0.08)),
    warmth: clamp01(0.45 + personality.sociability * 0.35 + randomFloat(-0.1, 0.1)),
  };
}

export function createRandomIdentity(): ManIdentity {
  const personality = createRandomPersonality();
  const name = MAN_NAMES[Math.floor(Math.random() * MAN_NAMES.length)];

  return {
    name,
    appearanceSeed: Math.floor(Math.random() * 100_000),
    personality,
    mood: createStartingMood(personality),
    createdAt: new Date().toISOString(),
  };
}

export function clampMood(mood: MoodState): MoodState {
  return {
    energy: clamp01(mood.energy),
    irritation: clamp01(mood.irritation),
    focus: clamp01(mood.focus),
    warmth: clamp01(mood.warmth),
  };
}
