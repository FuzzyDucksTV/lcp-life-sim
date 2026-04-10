import Phaser from 'phaser';
import './style.css';
import LifeSimScene from './game/scenes/LifeSimScene';
import { getWorldSizeFromContract } from './game/sim/contract';
import { UiBridge } from './game/sim/uiBridge';
import { AudioDirector, type AudioCue } from './game/sim/audio';
import type { CommandLogEntry, ManIdentity } from './game/types';

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('Missing #app root element.');
}

appRoot.innerHTML = `
  <main class="sim-layout">
    <section class="stage-panel">
      <header class="stage-header">
        <h1>Life Sim</h1>
        <p id="sim-status"></p>
      </header>
      <div id="game-canvas" class="game-canvas" aria-label="Simulation canvas"></div>
    </section>

    <aside class="control-panel">
      <section class="control-card">
        <h2>Door</h2>
        <button id="ring-bell" type="button" disabled>Ring Bell</button>
      </section>

      <section class="control-card">
        <h2>Message</h2>
        <form id="command-form" autocomplete="off">
          <label for="command-input">Polite command</label>
          <div class="command-row">
            <input
              id="command-input"
              type="text"
              maxlength="120"
              placeholder="Please play piano."
              disabled
            />
            <button id="send-command" type="button" disabled>Send</button>
          </div>
        </form>
        <p class="muted">Commands without "please" are ignored.</p>
      </section>

      <section class="control-card">
        <h2>Audio</h2>
        <button id="audio-toggle" type="button">Audio: ON</button>
        <div class="volume-control">
          <label for="music-volume">Music</label>
          <input id="music-volume" type="range" min="0" max="100" value="50" />
        </div>
        <div class="volume-control">
          <label for="sfx-volume">Sound Effects</label>
          <input id="sfx-volume" type="range" min="0" max="100" value="50" />
        </div>
      </section>

      <section class="control-card">
        <h2>Resident</h2>
        <div id="man-profile" class="profile-box"></div>
      </section>

      <section class="control-card">
        <h2>What's Happening</h2>
        <div id="command-log" class="log-box"></div>
      </section>
    </aside>
  </main>
`;

const ringBellButton = document.querySelector<HTMLButtonElement>('#ring-bell');
const sendButton = document.querySelector<HTMLButtonElement>('#send-command');
const audioButton = document.querySelector<HTMLButtonElement>('#audio-toggle');
const commandInput = document.querySelector<HTMLInputElement>('#command-input');
const statusLabel = document.querySelector<HTMLParagraphElement>('#sim-status');
const musicSlider = document.querySelector<HTMLInputElement>('#music-volume');
const sfxSlider = document.querySelector<HTMLInputElement>('#sfx-volume');

if (!ringBellButton || !sendButton || !audioButton || !commandInput || !statusLabel || !musicSlider || !sfxSlider) {
  throw new Error('UI shell is missing required control elements.');
}

const setControlsEnabled = (enabled: boolean): void => {
  ringBellButton.disabled = !enabled;
  sendButton.disabled = !enabled;
  commandInput.disabled = !enabled;
};

setControlsEnabled(false);

const worldSize = getWorldSizeFromContract();
const scene = new LifeSimScene();
const audio = new AudioDirector();
let sceneReady = false;

const bridge = new UiBridge({
  onRingBell: () => {
    audio.prime();
    if (!sceneReady) {
      return;
    }
    scene.ringBell();
  },
  onSubmitCommand: (input) => {
    audio.prime();
    if (!sceneReady) {
      return;
    }
    scene.submitPlayerCommand(input);
  },
});

audioButton.addEventListener('click', () => {
  const muted = audio.toggleMuted();
  audioButton.textContent = muted ? 'Audio: OFF' : 'Audio: ON';
});

// Unlock audio on the very first user interaction (click/touch/key anywhere)
const unlockAudio = (): void => {
  audio.prime();
  const runtimeScene = game.scene.getScene('LifeSimScene') as LifeSimScene | undefined;
  if (runtimeScene) {
    // Resume Phaser's sound context which is also blocked until interaction
    if (runtimeScene.sound && runtimeScene.sound.locked) {
      runtimeScene.sound.unlock();
    }
  }
  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('touchstart', unlockAudio);
  document.removeEventListener('keydown', unlockAudio);
};
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// Volume sliders — apply to Phaser sound manager when scene is ready
const applyVolumes = (): void => {
  const runtimeScene = game.scene.getScene('LifeSimScene') as LifeSimScene | undefined;
  if (!runtimeScene) return;

  const musicVol = Number(musicSlider.value) / 100;
  const sfxVol = Number(sfxSlider.value) / 100;

  // Store volumes on scene for use in tickSoundEffects / tickBackgroundMusic
  (runtimeScene as unknown as { musicVolume: number; sfxVolume: number }).musicVolume = musicVol;
  (runtimeScene as unknown as { musicVolume: number; sfxVolume: number }).sfxVolume = sfxVol;
};

musicSlider.addEventListener('input', applyVolumes);
sfxSlider.addEventListener('input', applyVolumes);

const markSceneReady = (): void => {
  if (sceneReady) {
    return;
  }
  sceneReady = true;
  setControlsEnabled(true);
  commandInput.focus();
  statusLabel.textContent = '';
  applyVolumes();
};

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-canvas',
  width: worldSize.width,
  height: worldSize.height,
  backgroundColor: '#090c10',
  scene: [scene],
  physics: {
    default: 'arcade',
    arcade: {
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
});

let eventsWired = false;
let wireAttempts = 0;
const MAX_WIRE_ATTEMPTS = 120;

const tryWireSceneEvents = (): void => {
  if (eventsWired) {
    return;
  }

  const runtimeScene = game.scene.getScene('LifeSimScene') as LifeSimScene | undefined;
  if (!runtimeScene || !runtimeScene.events) {
    wireAttempts += 1;
    if (wireAttempts >= MAX_WIRE_ATTEMPTS) {
      statusLabel.textContent = 'Failed to load. Please refresh.';
      return;
    }
    window.setTimeout(tryWireSceneEvents, 50);
    return;
  }

  eventsWired = true;

  runtimeScene.events.on('ui-log', (entry: CommandLogEntry) => {
    bridge.pushLog(entry);
  });

  runtimeScene.events.on('ui-profile', (identity: ManIdentity) => {
    bridge.renderProfile(identity);
  });

  runtimeScene.events.on('ui-audio-cue', (cue: AudioCue) => {
    audio.playCue(cue);
  });

  runtimeScene.events.once(Phaser.Scenes.Events.CREATE, markSceneReady);
  if (runtimeScene.sys.isActive()) {
    markSceneReady();
  }
};

if (game.isBooted) {
  tryWireSceneEvents();
} else {
  game.events.once(Phaser.Core.Events.READY, tryWireSceneEvents);
}
