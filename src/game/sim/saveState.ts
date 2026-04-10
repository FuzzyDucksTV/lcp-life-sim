import { createRandomIdentity } from './identity';
import type { ManIdentity, SaveSnapshot } from '../types';

const SAVE_KEY = 'lcp_phase7_state_v1';

function isBrowserStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function loadSnapshot(): SaveSnapshot | null {
  if (!isBrowserStorageAvailable()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as SaveSnapshot;
    if (parsed.version !== 1 || !parsed.manIdentity) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot: SaveSnapshot): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore quota and serialization errors.
  }
}

export function loadOrCreateIdentity(): ManIdentity {
  const snapshot = loadSnapshot();
  if (snapshot?.manIdentity) {
    return snapshot.manIdentity;
  }

  return createRandomIdentity();
}
