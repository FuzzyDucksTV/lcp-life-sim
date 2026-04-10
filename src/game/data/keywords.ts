import type { TaskType } from '../types';

const VOCAB_WORDS = [
  'add', 'allergy', 'anagrams', 'apathetic', 'appear', 'awful', 'bedroom', 'boogie', 'bored', 'bowl',
  'brush', 'burn', 'cabinet', 'can', 'card', 'chilly', 'chair', 'clean', 'closet', 'cold', 'commodore',
  'computer', 'confide', 'cooler', 'dance', 'dish', 'divide', 'do', 'dog', 'dresser', 'drink', 'dust',
  'enjoy', 'excuse', 'feed', 'fever', 'filing', 'fill', 'fire', 'floss', 'fluid', 'fluids', 'freezer',
  'fridge', 'fugue', 'get', 'game', 'glass', 'hangman', 'hanky', 'hate', 'hear', 'hello', 'hey', 'home',
  'homework', 'house', 'hygiene', 'if', 'ignite', 'imbibe', 'in', 'inside', 'is', 'ivories', 'jazz',
  'keep', 'kitchen', 'letter', 'light', 'like', 'liquid', 'listen', 'log', 'logon', 'look', 'looks',
  'make', 'math', 'matter', 'messy', 'moon', 'multiply', 'mutt', 'music', 'nightstand', 'note', 'on',
  'open', 'ored', 'ought', 'pardon', 'perform', 'pet', 'piano', 'pick', 'platter', 'play', 'please',
  'poker', 'pollen', 'pooch', 'problem', 'program', 'put', 'quit', 'record', 'refrigerator', 'relax',
  'seem', 'seems', 'serenade', 'should', 'show', 'sloppy', 'sonata', 'song', 'spin', 'start', 'stereo',
  'subtract', 'teeth', 'tell', 'tickle', 'tidy', 'tired', 'troubles', 'try', 'tune', 'turntable', 'tv',
  'type', 'untidy', 'upstairs', 'utilities', 'use', 'water', 'war', 'what', 'whats', 'another', 'running',
  'machine', 'runningmachine', 'computerdesk', 'desk', 'sit', 'down', 'at', 'a', 'to', 'me', 'the', 'another', 'song',
  'sofa', 'settee', 'bed', 'sleep', 'lay', 'lie', 'shower', 'bath', 'toilet', 'washing', 'washingmachine',
  'dishwasher', 'washer', 'cupboard', 'bookcase', 'worktop', 'counter', 'cooker', 'wardrobe', 'stove',
  'cook', 'read', 'turn', 'up', 'off', 'machine', 'take', 'lying', 'prince', 'like', 'watch', 'king',
  'change', 'shirt', 'top', 'tshirt', 'color', 'colour',
  'red', 'yellow', 'blue', 'green', 'purple', 'orange', 'white',
] as const;

export const VOCABULARY = new Set<string>(VOCAB_WORDS);

export function tokenizeInput(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function hasPlease(tokens: string[]): boolean {
  return tokens.includes('please');
}

export function getUnknownTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !VOCABULARY.has(token));
}

function includesAll(tokens: string[], required: string[]): boolean {
  return required.every((word) => tokens.includes(word));
}

function includesAny(tokens: string[], options: string[]): boolean {
  return options.some((word) => tokens.includes(word));
}

export function inferIntent(tokens: string[]): TaskType | null {
  if (includesAll(tokens, ['sleep', 'like', 'prince'])) {
    return 'sleep';
  }

  if (tokens.includes('pet') && (tokens.includes('dog') || tokens.includes('mutt') || tokens.includes('pooch'))) {
    return 'pet_dog';
  }

  if (includesAny(tokens, ['sit', 'use']) && tokens.includes('sofa')) {
    return 'sit_sofa';
  }

  if (includesAny(tokens, ['sit', 'use']) && tokens.includes('settee')) {
    return 'sit_settee';
  }

  if (
    (tokens.includes('sit') && tokens.includes('computer') && tokens.includes('desk')) ||
    (tokens.includes('sit') && tokens.includes('computerdesk'))
  ) {
    return 'sit_computer_desk';
  }

  if (tokens.includes('sit') && tokens.includes('piano')) {
    return 'sit_piano';
  }

  if (
    (includesAny(tokens, ['lay', 'lie', 'sleep', 'lying']) && includesAny(tokens, ['bed', 'bedroom'])) ||
    includesAll(tokens, ['lay', 'bed'])
  ) {
    return 'lay_bed';
  }

  if (includesAll(tokens, ['take', 'shower']) || includesAll(tokens, ['use', 'shower']) || includesAll(tokens, ['bath', 'shower'])) {
    return 'take_shower';
  }

  if (includesAny(tokens, ['use', 'sit']) && tokens.includes('toilet')) {
    return 'use_toilet';
  }

  if (includesAny(tokens, ['use', 'open']) && includesAny(tokens, ['fridge', 'refrigerator', 'freezer'])) {
    return 'use_fridge';
  }

  if (includesAny(tokens, ['use', 'kitchen']) && tokens.includes('sink')) {
    return 'use_kitchen_sink';
  }

  if (tokens.includes('washingmachine') || includesAll(tokens, ['washing', 'machine'])) {
    return 'use_washing_machine';
  }

  if (tokens.includes('dishwasher') || includesAll(tokens, ['dish', 'washer'])) {
    return 'use_dishwasher';
  }

  if (includesAny(tokens, ['open', 'use']) && includesAny(tokens, ['cupboard', 'cabinet'])) {
    return 'open_kitchen_cupboard';
  }

  if (tokens.includes('bookcase') && includesAny(tokens, ['use', 'open', 'read'])) {
    return 'use_bookcase';
  }

  if (includesAny(tokens, ['use', 'cook']) && includesAny(tokens, ['worktop', 'counter'])) {
    return 'use_kitchen_worktop';
  }

  if (includesAny(tokens, ['use', 'cook', 'turn']) && includesAny(tokens, ['cooker', 'stove'])) {
    return 'use_cooker';
  }

  if (includesAny(tokens, ['use', 'open']) && includesAny(tokens, ['wardrobe', 'closet', 'dresser'])) {
    return 'use_wardrobe';
  }

  if (
    (tokens.includes('sit') && tokens.includes('chair')) ||
    (tokens.includes('sit') && tokens.includes('down'))
  ) {
    return 'sit_chair';
  }

  if (
    (tokens.includes('computer') && tokens.includes('use')) ||
    (tokens.includes('computer') && tokens.includes('logon')) ||
    tokens.includes('computerdesk')
  ) {
    return 'use_computer';
  }

  if (tokens.includes('dance') || tokens.includes('boogie')) {
    return 'dance';
  }

  if (includesAll(tokens, ['type', 'letter'])) {
    return 'type_letter';
  }

  if (
    tokens.includes('runningmachine') ||
    includesAll(tokens, ['running', 'machine']) ||
    includesAll(tokens, ['use', 'running', 'machine'])
  ) {
    return 'use_running_machine';
  }

  if (tokens.includes('piano') && tokens.includes('play')) {
    return 'play_piano';
  }

  if (includesAll(tokens, ['play', 'another', 'song']) || includesAll(tokens, ['play', 'another', 'tune'])) {
    return 'play_another_song';
  }

  if (includesAll(tokens, ['turn', 'off']) && tokens.includes('tv')) {
    return 'turn_off_tv';
  }

  if (includesAny(tokens, ['watch', 'use']) && tokens.includes('tv')) {
    return 'use_tv';
  }

  if (tokens.includes('change') && includesAny(tokens, ['shirt', 'top', 'tshirt', 'color', 'colour'])) {
    return 'change_shirt';
  }

  return null;
}
