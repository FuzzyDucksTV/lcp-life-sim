import type { ManIdentity, MoodState, TaskType } from '../types';
import { clampMood } from './identity';

export interface ComplianceContext {
  recentAcceptRate: number;
  recentRejectRate: number;
  ringBellCount: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function tickMood(mood: MoodState, deltaMs: number, activeTask: TaskType): MoodState {
  const minuteFactor = deltaMs / 60_000;
  const isRest =
    activeTask === 'sleep' ||
    activeTask === 'idle' ||
    activeTask === 'idle_stand' ||
    activeTask === 'sit_chair' ||
    activeTask === 'sit_sofa' ||
    activeTask === 'sit_settee' ||
    activeTask === 'sit_computer_desk' ||
    activeTask === 'sit_piano' ||
    activeTask === 'lay_bed';
  const isWork =
    activeTask === 'use_running_machine' ||
    activeTask === 'play_piano' ||
    activeTask === 'type_letter' ||
    activeTask === 'use_computer' ||
    activeTask === 'use_washing_machine' ||
    activeTask === 'use_dishwasher' ||
    activeTask === 'use_kitchen_sink' ||
    activeTask === 'use_kitchen_worktop' ||
    activeTask === 'use_cooker' ||
    activeTask === 'open_kitchen_cupboard' ||
    activeTask === 'use_fridge' ||
    activeTask === 'use_bookcase' ||
    activeTask === 'use_wardrobe' ||
    activeTask === 'take_shower' ||
    activeTask === 'use_toilet';
  const isSocial = activeTask === 'pet_dog';

  const next: MoodState = {
    energy: mood.energy + (isRest ? 0.016 : -0.009) * minuteFactor,
    irritation: mood.irritation + (isWork ? 0.006 : isSocial ? -0.012 : -0.004) * minuteFactor,
    focus: mood.focus + (isWork ? 0.009 : isSocial ? 0.002 : -0.002) * minuteFactor,
    warmth: mood.warmth + (isRest ? 0.004 : isSocial ? 0.018 : -0.001) * minuteFactor,
  };

  return clampMood(next);
}

export function getComplianceChance(identity: ManIdentity, context: ComplianceContext): number {
  const personality = identity.personality;
  const mood = identity.mood;

  const score =
    0.18 +
    personality.obedience * 0.32 +
    personality.diligence * 0.2 +
    mood.warmth * 0.16 +
    mood.focus * 0.12 +
    context.recentAcceptRate * 0.16 -
    context.recentRejectRate * 0.12 -
    mood.irritation * 0.34 -
    Math.min(0.2, context.ringBellCount * 0.03);

  return clamp01(score);
}

export function onCommandAccepted(mood: MoodState): MoodState {
  return clampMood({
    ...mood,
    warmth: mood.warmth + 0.04,
    focus: mood.focus + 0.03,
    irritation: mood.irritation - 0.05,
  });
}

export function onCommandRejected(mood: MoodState): MoodState {
  return clampMood({
    ...mood,
    irritation: mood.irritation + 0.04,
    warmth: mood.warmth - 0.03,
    focus: mood.focus - 0.02,
  });
}
