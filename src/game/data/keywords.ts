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

export function inferIntent(tokens: string[]): TaskType | null {
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

  return null;
}
