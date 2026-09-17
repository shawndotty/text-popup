import { Plugin } from 'obsidian';
import { registerBlockScanner, removeAllActions } from './scanner';
import { normalizeSettings, TextPopupSettingTab, TextPopupSettings } from './settings';

export default class TextPopupPlugin extends Plugin {
	settings!: TextPopupSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new TextPopupSettingTab(this.app, this));
		registerBlockScanner(this);
	}

	onunload(): void {
		removeAllActions();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
