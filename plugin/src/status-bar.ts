import type { ConnectionStatus } from './types';

type SyncState = 'idle' | 'syncing' | ConnectionStatus;

const STATE_CONFIG: Record<SyncState, { icon: string; label: string; color?: string }> = {
  idle:           { icon: '✓', label: 'VPS Sync: idle' },
  syncing:        { icon: '↻', label: 'VPS Sync: syncing…' },
  connected:      { icon: '●', label: 'VPS Sync: connected' },
  disconnected:   { icon: '○', label: 'VPS Sync: disconnected', color: '#888' },
  connecting:     { icon: '…', label: 'VPS Sync: connecting…' },
  authenticating: { icon: '…', label: 'VPS Sync: authenticating…' },
  error:          { icon: '✗', label: 'VPS Sync: error', color: '#e05252' },
};

export class SyncStatusBar {
  private iconEl: HTMLSpanElement;
  private labelEl: HTMLSpanElement;
  private conflictTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private containerEl: HTMLElement) {
    containerEl.style.cursor = 'pointer';
    containerEl.title = 'VPS Sync status';

    this.iconEl = containerEl.createSpan({ cls: 'vps-sync-icon' });
    this.labelEl = containerEl.createSpan({ cls: 'vps-sync-label' });
    this.labelEl.style.marginLeft = '4px';

    this.setStatus('disconnected');
  }

  setStatus(state: SyncState, detail?: string): void {
    const config = STATE_CONFIG[state] ?? STATE_CONFIG['error'];

    this.iconEl.textContent = config.icon;
    this.labelEl.textContent = detail ? `${config.label} (${detail})` : config.label;

    if (config.color) {
      this.containerEl.style.color = config.color;
    } else {
      this.containerEl.style.color = '';
    }
  }

  showConflictBadge(count: number): void {
    if (this.conflictTimer) clearTimeout(this.conflictTimer);
    this.labelEl.textContent = `VPS Sync: ${count} conflict${count > 1 ? 's' : ''} created`;
    this.containerEl.style.color = '#e0a000';
    this.conflictTimer = setTimeout(() => {
      this.setStatus('connected');
    }, 5000);
  }
}
