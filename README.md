# lcp-life-sim

Little Computer People-inspired hidden life sim built with Phaser 3 + TypeScript.

Current state: **Phase 6.4**
- Autonomous routine loop (day beats and task transitions)
- Player command queue with politeness gate (`please` required)
- Interrupt/priority system (player requests and door delivery)
- Mood + personality driven compliance
- Dog companion movement and interaction beats
- Delayed narrative events (letter replies, queue follow-ups, daily reflection notes)
- Audio cues and event log UI

## Requirements

- Node.js 20+ (recommended)
- npm 10+ (recommended)

## Install

```bash
npm ci
```

## Run (Development)

```bash
npm run dev
```

Vite will print a local URL (usually `http://localhost:5173`).

Optional explicit host/port:

```bash
npm run dev -- --host 127.0.0.1 --port 4173
```

## Build

```bash
npm run build
```

## Preview Production Build

```bash
npm run preview
```

## Gameplay Controls

- **Ring Bell**: triggers door-delivery flow if available.
- **Message input**: send polite commands to influence behavior.
- **Audio toggle**: enable/disable procedural cue sounds.
- **Event Log**: shows system/player/man narrative output.

## Command Rules

- Commands **must include** `please`.
- Unknown words are rejected.
- Duplicate and spammy repeated requests can be refused in Phase 6.4.

Examples:
- `Please sit in a chair`
- `Please use computer`
- `Please type a letter`
- `Please play piano`
- `Please play another song`
- `Please dance`
- `Please pet the dog`
- `Please use running machine`

## Project Structure

- `src/main.ts`: app shell, scene bootstrap, UI wiring.
- `src/game/scenes/LifeSimScene.ts`: core simulation logic.
- `src/game/sim/*`: mood, parsing, navigation, save/load, contract helpers.
- `src/data/*`: house layout and runtime movement contract.
- `public/sprites`, `public/background`: art assets.

## Save Data

- Snapshot data is stored in browser localStorage under `lcp_phase6_state_v1`.
- Includes resident identity and current day index.
