import { Plugin } from 'obsidian';
import { VpsSyncSettingTab } from './settings';
import { SyncManager } from './sync-manager';
import { SyncStatusBar } from './status-bar';
import { DEFAULT_SETTINGS, type VpsSyncSettings } from './types';

export default class VpsSyncPlugin extends Plugin {
  settings!: VpsSyncSettings;
  syncManager!: SyncManager;
  statusBar!: SyncStatusBar;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Status bar (bottom right)
    this.statusBar = new SyncStatusBar(this.addStatusBarItem());

    // Sync manager
    this.syncManager = new SyncManager(this, this.settings);

    // Settings tab
    this.addSettingTab(new VpsSyncSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: 'force-full-sync',
      name: 'Force full sync now',
      callback: async () => {
        await this.syncManager.runStartupSyncPublic();
      },
    });

    this.addCommand({
      id: 'toggle-sync',
      name: 'Toggle sync on/off',
      callback: async () => {
        this.settings.syncEnabled = !this.settings.syncEnabled;
        await this.saveSettings();
        if (this.settings.syncEnabled) {
          await this.syncManager.start();
        } else {
          await this.syncManager.stop();
        }
      },
    });

    // Start syncing (if enabled)
    if (this.settings.syncEnabled && this.settings.serverUrl && this.settings.apiKey) {
      // Defer slightly so the vault is fully ready
      setTimeout(() => this.syncManager.start(), 500);
    }
  }

  async onunload(): Promise<void> {
    await this.syncManager.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
