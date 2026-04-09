export type AudioCue = 'bell' | 'positive' | 'negative' | 'routine_shift' | 'door';

function inBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined';
}

export class AudioDirector {
  private context: AudioContext | null = null;
  private muted = false;

  public prime(): void {
    if (!inBrowser()) {
      return;
    }
    if (!this.context) {
      this.context = new window.AudioContext();
    }
    void this.context.resume();
  }

  public toggleMuted(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public playCue(cue: AudioCue): void {
    if (this.muted || !inBrowser()) {
      return;
    }

    this.prime();
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') {
      return;
    }

    const start = ctx.currentTime + 0.01;
    switch (cue) {
      case 'bell':
        this.tone(740, 0.1, start, 0.035, 'triangle');
        this.tone(1046, 0.16, start + 0.11, 0.03, 'triangle');
        break;
      case 'positive':
        this.tone(620, 0.08, start, 0.028, 'sine');
        this.tone(784, 0.1, start + 0.09, 0.028, 'sine');
        break;
      case 'negative':
        this.tone(260, 0.12, start, 0.032, 'square');
        break;
      case 'routine_shift':
        this.tone(420, 0.06, start, 0.02, 'sine');
        break;
      case 'door':
        this.tone(320, 0.08, start, 0.03, 'triangle');
        this.tone(240, 0.12, start + 0.09, 0.028, 'triangle');
        break;
      default:
        break;
    }
  }

  private tone(
    frequency: number,
    duration: number,
    startAt: number,
    gainPeak: number,
    type: OscillatorType
  ): void {
    if (!this.context) {
      return;
    }

    const ctx = this.context;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(gainPeak, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}
