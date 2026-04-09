import { getUnknownTokens, hasPlease, inferIntent, tokenizeInput } from '../data/keywords';
import type { SimCommand } from '../types';

function buildFeedback(intent: SimCommand['intent']): string {
  switch (intent) {
    case 'pet_dog':
      return 'I can ask him to pet the dog.';
    case 'sit_chair':
      return 'I can ask him to sit in a chair.';
    case 'sit_sofa':
      return 'I can ask him to sit on the sofa.';
    case 'sit_settee':
      return 'I can ask him to sit on the settee.';
    case 'sit_computer_desk':
      return 'I can ask him to sit at the computer desk.';
    case 'sit_piano':
      return 'I can ask him to sit at the piano.';
    case 'lay_bed':
      return 'I can ask him to lay in bed.';
    case 'take_shower':
      return 'I can ask him to take a shower.';
    case 'use_toilet':
      return 'I can ask him to use the toilet.';
    case 'use_fridge':
      return 'I can ask him to use the fridge.';
    case 'use_kitchen_sink':
      return 'I can ask him to use the kitchen sink.';
    case 'use_washing_machine':
      return 'I can ask him to use the washing machine.';
    case 'use_dishwasher':
      return 'I can ask him to use the dishwasher.';
    case 'open_kitchen_cupboard':
      return 'I can ask him to open a kitchen cupboard.';
    case 'use_bookcase':
      return 'I can ask him to use the bookcase.';
    case 'use_kitchen_worktop':
      return 'I can ask him to use the kitchen worktop.';
    case 'use_cooker':
      return 'I can ask him to use the cooker.';
    case 'use_wardrobe':
      return 'I can ask him to use the wardrobe.';
    case 'use_computer':
      return 'I can ask him to use the computer.';
    case 'type_letter':
      return 'I can ask him to type a letter.';
    case 'use_running_machine':
      return 'I can ask him to use the running machine.';
    case 'play_piano':
      return 'I can ask him to play piano.';
    case 'play_another_song':
      return 'I can ask him to play another song.';
    case 'dance':
      return 'I can ask him to dance.';
    case 'sleep':
      return 'I can ask him to sleep.';
    default:
      return 'He heard you, but not enough to assign a specific action.';
  }
}

export function parsePlayerCommand(raw: string): SimCommand {
  const normalized = raw.trim().replace(/\s+/g, ' ');
  const tokens = tokenizeInput(normalized);

  if (tokens.length === 0) {
    return {
      raw,
      normalized,
      tokens,
      requiresPlease: true,
      isUnderstood: false,
      intent: null,
      feedback: 'Say something polite, for example: "Please dance."',
    };
  }

  if (!hasPlease(tokens)) {
    return {
      raw,
      normalized,
      tokens,
      requiresPlease: true,
      isUnderstood: false,
      intent: null,
      feedback: 'He ignores commands that do not include "please".',
    };
  }

  const unknownTokens = getUnknownTokens(tokens);
  if (unknownTokens.length > 0) {
    return {
      raw,
      normalized,
      tokens,
      requiresPlease: true,
      isUnderstood: false,
      intent: null,
      feedback: `He does not understand: ${unknownTokens.join(', ')}`,
    };
  }

  const intent = inferIntent(tokens);

  return {
    raw,
    normalized,
    tokens,
    requiresPlease: true,
    isUnderstood: true,
    intent,
    feedback: buildFeedback(intent),
  };
}
