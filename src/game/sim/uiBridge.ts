import type { CommandLogEntry, ManIdentity } from '../types';

interface UiBridgeOptions {
  onRingBell: () => void;
  onSubmitCommand: (input: string) => void;
}

export class UiBridge {
  private readonly bellButton: HTMLButtonElement;
  private readonly commandInput: HTMLInputElement;
  private readonly commandButton: HTMLButtonElement;
  private readonly commandForm: HTMLFormElement;
  private readonly profilePanel: HTMLDivElement;
  private readonly logPanel: HTMLDivElement;

  constructor(options: UiBridgeOptions) {
    this.bellButton = document.querySelector<HTMLButtonElement>('#ring-bell') as HTMLButtonElement;
    this.commandInput = document.querySelector<HTMLInputElement>('#command-input') as HTMLInputElement;
    this.commandButton = document.querySelector<HTMLButtonElement>('#send-command') as HTMLButtonElement;
    this.commandForm = document.querySelector<HTMLFormElement>('#command-form') as HTMLFormElement;
    this.profilePanel = document.querySelector<HTMLDivElement>('#man-profile') as HTMLDivElement;
    this.logPanel = document.querySelector<HTMLDivElement>('#command-log') as HTMLDivElement;

    this.bellButton.addEventListener('click', () => {
      options.onRingBell();
      this.commandInput.focus();
    });

    this.commandForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = this.commandInput.value.trim();
      if (value.length === 0) {
        return;
      }
      options.onSubmitCommand(value);
      this.commandInput.value = '';
      this.commandInput.focus();
    });

    this.commandButton.addEventListener('click', () => {
      this.commandForm.requestSubmit();
    });
  }

  public renderProfile(identity: ManIdentity): void {
    const dogName = identity.dog?.name ?? 'the dog';

    this.profilePanel.innerHTML = [
      `<h3>${identity.name} & ${dogName}</h3>`,
      `<p class="backstory">${identity.backstory ?? 'A quiet resident and his faithful companion.'}</p>`,
    ].join('');
  }

  public pushLog(entry: CommandLogEntry): void {
    // Hide system events from the log
    if (entry.source === 'system') {
      return;
    }

    const row = document.createElement('div');
    row.className = `log-row ${entry.source}`;

    const prefix = entry.source === 'player' ? 'You' : 'Man';
    row.textContent = `${prefix}: ${entry.text}`;

    this.logPanel.prepend(row);

    const rows = this.logPanel.querySelectorAll('.log-row');
    if (rows.length > 25) {
      rows[rows.length - 1].remove();
    }
  }
}
