import type { ManIdentity, MoodState, Personality, LifestyleTraits, DogPersonality } from '../types';

const MAN_NAMES = [
  'Adam', 'Alex', 'Arlo', 'Ben', 'Carl', 'Colin', 'Darren', 'Eli', 'Evan', 'Felix',
  'Gabe', 'Hugo', 'Ian', 'Jules', 'Kai', 'Leo', 'Liam', 'Mason', 'Milo', 'Noah',
  'Oliver', 'Owen', 'Paul', 'Quinn', 'Reed', 'Sam', 'Theo', 'Toby', 'Victor', 'Wes',
];

const DOG_NAMES = [
  'Biscuit', 'Buddy', 'Charlie', 'Coco', 'Daisy', 'Duke', 'Finn', 'Ginger',
  'Lucky', 'Max', 'Muffin', 'Patch', 'Pepper', 'Rex', 'Rosie', 'Rusty',
  'Scout', 'Shadow', 'Teddy', 'Ziggy',
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

function createLifestyleTraits(personality: Personality): LifestyleTraits {
  // Each trait is influenced by personality but has its own randomness
  return {
    lovesGaming: clamp01(personality.playfulness * 0.5 + randomFloat(0.1, 0.6)),
    lovesPiano: clamp01(personality.diligence * 0.3 + randomFloat(0.1, 0.7)),
    lovesTV: clamp01((1 - personality.diligence) * 0.4 + randomFloat(0.1, 0.5)),
    lovesReading: clamp01(personality.diligence * 0.5 + randomFloat(0.05, 0.5)),
    lovesExercise: clamp01(randomFloat(0.15, 0.85)),
    lovesFood: clamp01(randomFloat(0.2, 0.9)),
    hygiene: clamp01(personality.diligence * 0.3 + randomFloat(0.3, 0.7)),
    sedentary: clamp01((1 - personality.playfulness) * 0.3 + randomFloat(0.1, 0.5)),
  };
}

function createDogPersonality(): DogPersonality {
  const name = DOG_NAMES[Math.floor(Math.random() * DOG_NAMES.length)];
  return {
    name,
    lovesFood: clamp01(randomFloat(0.2, 0.95)),
    lovesSleep: clamp01(randomFloat(0.15, 0.85)),
    energy: clamp01(randomFloat(0.2, 0.9)),
  };
}

function generateBackstory(
  manName: string,
  personality: Personality,
  lifestyle: LifestyleTraits,
  dog: DogPersonality,
): string {
  // Pick a backstory template based on dominant traits
  const stories: Array<{ condition: () => boolean; text: string }> = [
    {
      condition: () => lifestyle.lovesGaming > 0.65 && lifestyle.lovesPiano > 0.5,
      text: `${manName} is a creative soul who splits his time between the glow of a monitor and the keys of a piano. He grew up tinkering with retro games and taught himself to play music by ear. His dog ${dog.name} ${dog.lovesSleep > 0.6 ? 'likes nothing more than snoozing nearby while he plays' : 'bounces around excitedly whenever the music starts'}. ${dog.lovesFood > 0.7 ? `${dog.name} has a bottomless appetite and will eat at every opportunity.` : `${dog.name} is a fussy eater who only eats when truly hungry.`} ${manName} moved here for some peace and quiet, hoping to finally finish the album he started years ago.`,
    },
    {
      condition: () => lifestyle.lovesExercise > 0.65 && lifestyle.hygiene > 0.6,
      text: `${manName} is a fitness enthusiast who starts each day on the running machine. He's meticulous about his routine — exercise, shower, then a proper breakfast. His companion ${dog.name} ${dog.energy > 0.6 ? 'matches his energy perfectly, always ready for action' : 'prefers to watch from a comfortable spot'}. ${dog.lovesFood > 0.7 ? `${dog.name} burns through food as fast as it arrives.` : `${dog.name} eats modestly, preferring naps to snacks.`} ${manName} moved to this house after years in a cramped flat, thrilled to finally have space for his equipment.`,
    },
    {
      condition: () => lifestyle.lovesFood > 0.7 && lifestyle.lovesTV > 0.5,
      text: `${manName} is a self-taught cook who treats every meal like an event. He'll spend ages at the worktop and cooker, then settle in front of the TV to watch cooking shows for inspiration. ${dog.name} ${dog.lovesFood > 0.6 ? 'has learned to hang around the kitchen in hopes of scraps' : 'shows little interest in human food but enjoys the company'}. ${dog.lovesSleep > 0.6 ? `When ${manName} watches TV, ${dog.name} dozes off on the floor nearby.` : `${dog.name} stays alert, watching the screen with curious eyes.`} He chose this place because the kitchen was bigger than the bedroom.`,
    },
    {
      condition: () => lifestyle.lovesReading > 0.6 && personality.diligence > 0.6,
      text: `${manName} is a quiet, studious type who can lose hours at the bookcase. He keeps a carefully organised reading list and writes detailed notes on his computer. ${dog.name} ${dog.lovesSleep > 0.5 ? 'often sleeps at his feet while he reads' : 'nudges him when it\'s time for a break'}. ${dog.lovesFood > 0.7 ? `${dog.name} is always hungry and makes it known.` : `${dog.name} is content with regular meals and doesn't beg.`} ${manName} moved here after inheriting a collection of books too large for his old place.`,
    },
    {
      condition: () => personality.playfulness > 0.65 && lifestyle.lovesGaming > 0.5,
      text: `${manName} is the life and soul — when he's not gaming, he's dancing around the house or banging out tunes on the piano. He doesn't take life too seriously. ${dog.name} ${dog.energy > 0.6 ? 'feeds off his chaotic energy and follows him everywhere' : 'watches his antics with a weary but affectionate gaze'}. ${dog.lovesFood > 0.6 ? `${dog.name} shares his love of snacking.` : `${dog.name} is more disciplined about mealtimes than he is.`} He ended up here after his flatmates asked him to find somewhere his music wouldn't bother anyone.`,
    },
    {
      condition: () => lifestyle.sedentary > 0.55 && lifestyle.lovesTV > 0.5,
      text: `${manName} is a homebody who's perfected the art of doing very little. He drifts between the settee and the TV, occasionally making himself something to eat. ${dog.name} ${dog.lovesSleep > 0.6 ? 'is his perfect match — equally fond of a quiet afternoon nap' : 'tries to drag him outside more often than he\'d like'}. ${dog.lovesFood > 0.7 ? `They both share an enthusiasm for food.` : `${dog.name} eats sparingly, unlike ${manName}.`} He moved here because the previous tenant left behind a very comfortable sofa.`,
    },
    {
      condition: () => lifestyle.hygiene > 0.7 && personality.obedience > 0.65,
      text: `${manName} is neat, polite, and runs his household like clockwork. Everything has its place, and he showers twice a day without fail. ${dog.name} ${dog.energy > 0.5 ? 'has been well trained and follows commands eagerly' : 'is a calm, obedient companion who rarely causes trouble'}. ${dog.lovesFood > 0.6 ? `The only chaos comes at mealtimes when ${dog.name} gets overexcited.` : `${dog.name} waits patiently for food and never begs.`} He chose this house for its layout — everything in the right place, just as he likes it.`,
    },
    {
      condition: () => lifestyle.lovesPiano > 0.65 && lifestyle.lovesReading > 0.5,
      text: `${manName} fancies himself a bit of an intellectual — he reads voraciously and plays piano to unwind. He's working on a novel, though he spends more time playing Chopin than actually writing. ${dog.name} ${dog.lovesSleep > 0.5 ? 'has become accustomed to the piano as a lullaby' : 'howls along enthusiastically, which he claims is singing'}. ${dog.lovesFood > 0.7 ? `${dog.name} interrupts creative sessions to demand food.` : `${dog.name} is low-maintenance and lets him work in peace.`} He found this house through a friend and fell in love with the natural light.`,
    },
    {
      condition: () => lifestyle.lovesExercise > 0.5 && lifestyle.lovesFood > 0.6,
      text: `${manName} lives by a simple philosophy: eat well, exercise hard. He spends his mornings on the running machine and his afternoons cooking elaborate meals. ${dog.name} ${dog.lovesFood > 0.6 ? 'has adopted the same philosophy, minus the exercise' : 'stays active and doesn\'t overindulge'}. ${dog.lovesSleep > 0.6 ? `After meals, they both settle in for a long nap.` : `${dog.name} stays energetic even after a big feed.`} He moved here because the kitchen is close to the running machine — efficiency in all things.`,
    },
    {
      condition: () => true, // Default fallback
      text: `${manName} is an easygoing chap who takes each day as it comes. He enjoys a bit of everything — some TV here, a meal there, maybe some time at the piano if the mood strikes. ${dog.name} ${dog.energy > 0.5 ? 'keeps him on his toes with boundless energy' : 'is his laid-back companion, happy to go with the flow'}. ${dog.lovesFood > 0.6 ? `${dog.name} is always first to the food bowl.` : `${dog.name} eats when hungry and doesn't fuss.`} They moved here together after ${manName} decided it was time for a fresh start somewhere quiet.`,
    },
  ];

  // Find first matching story
  for (const story of stories) {
    if (story.condition()) {
      return story.text;
    }
  }

  return stories[stories.length - 1].text;
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
  const lifestyle = createLifestyleTraits(personality);
  const dog = createDogPersonality();
  const name = MAN_NAMES[Math.floor(Math.random() * MAN_NAMES.length)];
  const backstory = generateBackstory(name, personality, lifestyle, dog);

  return {
    name,
    appearanceSeed: Math.floor(Math.random() * 100_000),
    personality,
    lifestyle,
    dog,
    backstory,
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
