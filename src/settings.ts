import { App, PluginSettingTab, Setting } from 'obsidian';
import type TextPopupPlugin from './main';
import { refreshTextPopupActions } from './scanner';
import { DEFAULT_TAGS, normalizeTagList } from './tags';

export interface TextPopupSettings {
	/** 是否在实时预览中显示放大图标。 */
	enabled: boolean;
	/** 弹窗背景色；空字符串表示跟随主题。 */
	popupBackgroundColor: string;
	/** 弹窗文字颜色；空字符串表示跟随主题。 */
	popupTextColor: string;
	/** 弹窗默认字号（px）。 */
	popupFontSize: number;
	/** 被标记时触发放大的标签列表（设置页可编辑）。 */
	supportedTags: string[];
}

export const DEFAULT_SETTINGS: TextPopupSettings = {
	enabled: true,
	popupBackgroundColor: '',
	popupTextColor: '',
	popupFontSize: 16,
	supportedTags: [...DEFAULT_TAGS],
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 72;
export const FONT_SIZE_STEP = 1;

/** 弹窗内缩放的上下限与步长（缩放是按比例作用于字号的）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.1;

function clampFontSize(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.popupFontSize;
	return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

/** 把磁盘上可能残缺 / 过期的数据整理成一份完整设置。 */
export function normalizeSettings(raw: unknown): TextPopupSettings {
	const data = (raw ?? {}) as Partial<TextPopupSettings>;
	return {
		enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_SETTINGS.enabled,
		popupBackgroundColor: readString(
			data.popupBackgroundColor,
			DEFAULT_SETTINGS.popupBackgroundColor,
		),
		popupTextColor: readString(data.popupTextColor, DEFAULT_SETTINGS.popupTextColor),
		popupFontSize: clampFontSize(data.popupFontSize),
		supportedTags: normalizeTagList(data.supportedTags),
	};
}

export class TextPopupSettingTab extends PluginSettingTab {
	private plugin: TextPopupPlugin;

	constructor(app: App, plugin: TextPopupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('启用放大图标')
			.setDesc('在实时预览中，为块级 HTML 内容显示放大图标。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					refreshTextPopupActions(this.plugin);
				}),
			);

		this.addColorSetting(
			containerEl,
			'弹窗背景色',
			'留空则跟随主题背景色。',
			'popupBackgroundColor',
			'#2b2b2b',
		);

		this.addColorSetting(
			containerEl,
			'弹窗文字颜色',
			'留空则跟随主题文字颜色。',
			'popupTextColor',
			'#dcddde',
		);

		new Setting(containerEl)
			.setName('弹窗字号')
			.setDesc('弹窗内文字的默认字号，单位为像素。弹窗内还可以临时调整。')
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP)
					.setValue(this.plugin.settings.popupFontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.popupFontSize = clampFontSize(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('支持的标签')
			.setDesc('用逗号分隔，例如 div, p。修改后立即生效，不需要改代码。')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_TAGS.join(', '))
					.setValue(this.plugin.settings.supportedTags.join(', '))
					.onChange(async (value) => {
						const tags = normalizeTagList(value);
						if (tags.join(',') === this.plugin.settings.supportedTags.join(',')) return;
						this.plugin.settings.supportedTags = tags;
						await this.plugin.saveSettings();
						refreshTextPopupActions(this.plugin);
					}),
			);
	}

	/** 颜色设置：颜色选择器 + 「跟随主题」按钮（把值置空即回落到主题色）。 */
	private addColorSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: 'popupBackgroundColor' | 'popupTextColor',
		fallbackHex: string,
	): void {
		let statusEl: HTMLElement | null = null;

		const describe = (value: string): string => (value ? value : '跟随主题');
		const render = (value: string): void => {
			if (statusEl) statusEl.setText(describe(value));
		};

		const setting = new Setting(containerEl).setName(name).setDesc(desc);

		setting.addColorPicker((picker) => {
			picker.setValue(this.plugin.settings[key] || fallbackHex);
			picker.onChange(async (value) => {
				this.plugin.settings[key] = value;
				await this.plugin.saveSettings();
				render(value);
			});
		});

		setting.addButton((button) =>
			button.setButtonText('跟随主题').onClick(async () => {
				this.plugin.settings[key] = '';
				await this.plugin.saveSettings();
				render('');
			}),
		);

		statusEl = setting.controlEl.createSpan({ cls: 'text-popup-setting-status' });
		render(this.plugin.settings[key]);
	}
}
