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
        <h1>Little Computer People: Hidden Sim</h1>
        <p id="sim-status">Loading simulation...</p>
      </header>
      <div id="game-canvas" class="game-canvas" aria-label="Simulation canvas"></div>
    </section>

    <aside class="control-panel">
      <section class="control-card">
        <h2>Door</h2>
        <button id="ring-bell" type="button" disabled>Ring Bell</button>
        <button id="audio-toggle" type="button">Audio: ON</button>
        <p class="muted">Door flow is fixed: 3 seconds outside.</p>
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
        <h2>Resident</h2>
        <div id="man-profile" class="profile-box"></div>
      </section>

      <section class="control-card">
        <h2>Event Log</h2>
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

if (!ringBellButton || !sendButton || !audioButton || !commandInput || !statusLabel) {
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

scene.events.on('ui-log', (entry: CommandLogEntry) => {
  bridge.pushLog(entry);
});

scene.events.on('ui-profile', (identity: ManIdentity) => {
  bridge.renderProfile(identity);
});

scene.events.on('ui-audio-cue', (cue: AudioCue) => {
  audio.playCue(cue);
});

scene.events.once(Phaser.Scenes.Events.CREATE, () => {
  sceneReady = true;
  setControlsEnabled(true);
  commandInput.focus();
  statusLabel.textContent = 'Simulation running (hidden AI mode).';
});

new Phaser.Game({
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
