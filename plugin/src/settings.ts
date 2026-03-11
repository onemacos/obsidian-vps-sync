import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type VpsSyncPlugin from './main';
import { DEFAULT_SETTINGS } from './types';

export class VpsSyncSettingTab extends PluginSettingTab {
  plugin: VpsSyncPlugin;

  constructor(app: App, plugin: VpsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'VPS Sync Settings' });

    // ── Connection ──────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Connection' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket URL of your VPS sync server (e.g. wss://yourserver.com:3241)')
      .addText(text =>
        text
          .setPlaceholder('wss://yourserver.com:3241')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async value => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Secret key configured on your VPS server')
      .addText(text => {
        text
          .setPlaceholder('Enter API key...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async value => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        // Mask the input
        text.inputEl.type = 'password';
      });

    // ── Sync Options ─────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Sync Options' });

    new Setting(containerEl)
      .setName('Enable sync')
      .setDesc('Toggle real-time sync on or off')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.syncEnabled)
          .onChange(async value => {
            this.plugin.settings.syncEnabled = value;
            await this.plugin.saveSettings();
            if (value) {
              await this.plugin.syncManager?.start();
            } else {
              await this.plugin.syncManager?.stop();
            }
          })
      );

    new Setting(containerEl)
      .setName('Exclude patterns')
      .setDesc(
        'Files matching these glob patterns will not be synced. One pattern per line.\n' +
        'Example: .obsidian/**, *.tmp'
      )
      .addTextArea(area => {
        area
          .setPlaceholder('.obsidian/**\n*.tmp\n.DS_Store')
          .setValue(this.plugin.settings.excludePatterns.join('\n'))
          .onChange(async value => {
            this.plugin.settings.excludePatterns = value
              .split('\n')
              .map(p => p.trim())
              .filter(p => p.length > 0);
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 5;
        area.inputEl.style.width = '100%';
        area.inputEl.style.fontFamily = 'monospace';
      });

    // ── Actions ──────────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Actions' });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify that the server URL and API key are correct')
      .addButton(btn =>
        btn
          .setButtonText('Test Connection')
          .setCta()
          .onClick(async () => {
            btn.setButtonText('Testing...');
            btn.setDisabled(true);
            try {
              const ok = await this.plugin.syncManager?.testConnection();
              if (ok) {
                new Notice('VPS Sync: Connection successful!');
              } else {
                new Notice('VPS Sync: Connection failed. Check URL and API key.');
              }
            } catch {
              new Notice('VPS Sync: Connection error. Check URL and API key.');
            } finally {
              btn.setButtonText('Test Connection');
              btn.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
      .setName('Force full sync')
      .setDesc('Trigger a full startup sync right now (re-compares all files)')
      .addButton(btn =>
        btn
          .setButtonText('Sync Now')
          .onClick(async () => {
            btn.setButtonText('Syncing...');
            btn.setDisabled(true);
            try {
              await this.plugin.syncManager?.runStartupSyncPublic();
              new Notice('VPS Sync: Full sync complete!');
            } catch (e) {
              new Notice(`VPS Sync: Sync failed — ${e}`);
            } finally {
              btn.setButtonText('Sync Now');
              btn.setDisabled(false);
            }
          })
      );

    // ── Reset ─────────────────────────────────────────────────────────────────

    new Setting(containerEl)
      .setName('Reset to defaults')
      .setDesc('Restore all settings to their default values')
      .addButton(btn =>
        btn
          .setButtonText('Reset')
          .setWarning()
          .onClick(async () => {
            Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
            new Notice('VPS Sync: Settings reset to defaults.');
          })
      );
  }
}
