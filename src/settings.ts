import { App, PluginSettingTab, Setting } from 'obsidian';
import type { DropdownComponent } from 'obsidian';
import { isBlockLevelTag } from './blocks';
import { t } from './lang/helpers';
import type TextPopupPlugin from './main';
import { refreshTextPopupActions } from './scanner';
import { DEFAULT_TAGS, normalizeTagList } from './tags';

/** 三类 Obsidian 原生区块的开关；块级原始 HTML 由「支持的标签」控制，不在这里。 */
export type BlockKindSettings = Record<'code' | 'callout' | 'math', boolean>;

export interface TextPopupSettings {
	/** 是否在实时预览中显示放大图标。 */
	enabled: boolean;
	/** 弹窗内渲染块里的 HTML 与 Markdown；关闭则按纯文本显示。 */
	renderRichText: boolean;
	/** 弹窗背景色；空字符串表示跟随主题。 */
	popupBackgroundColor: string;
	/** 弹窗文字颜色；空字符串表示跟随主题。 */
	popupTextColor: string;
	/** 弹窗默认字号（px）。 */
	popupFontSize: number;
	/** 被标记时触发放大的标签列表（设置页可编辑）。 */
	supportedTags: string[];
	/** 代码块 / Callout / 数学块是否显示放大图标。 */
	blockKinds: BlockKindSettings;
	/** `Popup Selected Text` 用来包裹文本的标签；必须是 supportedTags 里的块级标签。 */
	popupTag: string;
}

export const DEFAULT_SETTINGS: TextPopupSettings = {
	enabled: true,
	renderRichText: true,
	popupBackgroundColor: '',
	popupTextColor: '',
	popupFontSize: 16,
	supportedTags: [...DEFAULT_TAGS],
	blockKinds: { code: true, callout: true, math: true },
	popupTag: 'div',
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

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** 老 `data.json` 没有 `blockKinds`，逐键回落到默认值即可，不需要迁移脚本。 */
function readBlockKinds(value: unknown): BlockKindSettings {
	const data = (value ?? {}) as Partial<BlockKindSettings>;
	return {
		code: readBoolean(data.code, DEFAULT_SETTINGS.blockKinds.code),
		callout: readBoolean(data.callout, DEFAULT_SETTINGS.blockKinds.callout),
		math: readBoolean(data.math, DEFAULT_SETTINGS.blockKinds.math),
	};
}

/**
 * 包裹标签的约束式回落：必须同时「在支持列表里」与「是块级标签」才采纳，
 * 否则取支持列表里第一个块级标签（列表里没有块级标签时回落到默认的 `div`）。
 * 老 `data.json` 没有这个字段 → 自动补齐，不需要迁移脚本。
 */
export function resolvePopupTag(tag: unknown, supportedTags: readonly string[]): string {
	const blockTags = supportedTags.filter(isBlockLevelTag);
	if (typeof tag === 'string' && blockTags.includes(tag)) return tag;
	return blockTags[0] ?? DEFAULT_SETTINGS.popupTag;
}

/** 把磁盘上可能残缺 / 过期的数据整理成一份完整设置。 */
export function normalizeSettings(raw: unknown): TextPopupSettings {
	const data = (raw ?? {}) as Partial<TextPopupSettings>;
	const supportedTags = normalizeTagList(data.supportedTags);
	return {
		enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_SETTINGS.enabled,
		renderRichText:
			typeof data.renderRichText === 'boolean'
				? data.renderRichText
				: DEFAULT_SETTINGS.renderRichText,
		popupBackgroundColor: readString(
			data.popupBackgroundColor,
			DEFAULT_SETTINGS.popupBackgroundColor,
		),
		popupTextColor: readString(data.popupTextColor, DEFAULT_SETTINGS.popupTextColor),
		popupFontSize: clampFontSize(data.popupFontSize),
		supportedTags,
		blockKinds: readBlockKinds(data.blockKinds),
		popupTag: resolvePopupTag(data.popupTag, supportedTags),
	};
}

export class TextPopupSettingTab extends PluginSettingTab {
	private plugin: TextPopupPlugin;
	/** 「包裹标签」下拉框；「支持的标签」改动把它挤掉时用它同步显示，不整页重绘。 */
	private popupTagDropdown: DropdownComponent | null = null;

	constructor(app: App, plugin: TextPopupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t('Enable magnifier icon'))
			.setDesc(t('Show a magnifier icon for supported blocks in Live Preview.'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					refreshTextPopupActions(this.plugin);
				}),
			);

		this.addBlockKindSetting(
			containerEl,
			'code',
			t('Magnify code blocks'),
			t('Show a magnifier icon for fenced code blocks in Live Preview.'),
		);
		this.addBlockKindSetting(
			containerEl,
			'callout',
			t('Magnify callouts'),
			t('Show a magnifier icon for callouts in Live Preview.'),
		);
		this.addBlockKindSetting(
			containerEl,
			'math',
			t('Magnify math blocks'),
			t('Show a magnifier icon for $$ math blocks in Live Preview.'),
		);

		new Setting(containerEl)
			.setName(t('Render HTML and Markdown'))
			.setDesc(
				t(
					"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.",
				),
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderRichText).onChange(async (value) => {
					this.plugin.settings.renderRichText = value;
					await this.plugin.saveSettings();
				}),
			);

		this.addColorSetting(
			containerEl,
			t('Popup background color'),
			t('Leave empty to follow the theme background color.'),
			'popupBackgroundColor',
			'#2b2b2b',
		);

		this.addColorSetting(
			containerEl,
			t('Popup text color'),
			t('Leave empty to follow the theme text color.'),
			'popupTextColor',
			'#dcddde',
		);

		new Setting(containerEl)
			.setName(t('Popup font size'))
			.setDesc(
				t(
					'Default font size inside the popup, in pixels. You can also adjust it inside the popup.',
				),
			)
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
			.setName(t('Supported tags'))
			.setDesc(
				t(
					'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.',
				),
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_TAGS.join(', '))
					.setValue(this.plugin.settings.supportedTags.join(', '))
					.onChange(async (value) => {
						const tags = normalizeTagList(value);
						if (tags.join(',') === this.plugin.settings.supportedTags.join(',')) return;
						this.plugin.settings.supportedTags = tags;
						// 列表改小可能把当前包裹标签挤掉，顺手回落到下一个合法标签。
						// 不整页重绘：那会让正在输入的这个文本框失焦。
						const popupTag = resolvePopupTag(this.plugin.settings.popupTag, tags);
						this.plugin.settings.popupTag = popupTag;
						this.popupTagDropdown?.setValue(popupTag);
						await this.plugin.saveSettings();
						refreshTextPopupActions(this.plugin);
					}),
			);

		this.addPopupTagSetting(containerEl);
	}

	/**
	 * 包裹标签：`Popup Selected Text` 生成块时用的外层标签。
	 * 选项只取「支持的标签」里的块级标签 —— 行内标签（`span` 等）生成的块不会有放大图标。
	 */
	private addPopupTagSetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName(t('Wrapper tag'))
			.setDesc(
				t(
					'Which block-level tag the conversion commands use to wrap the selected text. Only block-level tags can produce a magnifiable block.',
				),
			);

		setting.addDropdown((dropdown) => {
			// 当前值一定留在选项里：否则 supportedTags 被改空后下拉框会显示成空白
			const tags = new Set([
				...this.plugin.settings.supportedTags.filter(isBlockLevelTag),
				this.plugin.settings.popupTag,
			]);
			for (const tag of tags) dropdown.addOption(tag, tag);
			dropdown.setValue(this.plugin.settings.popupTag).onChange(async (value) => {
				this.plugin.settings.popupTag = resolvePopupTag(value, this.plugin.settings.supportedTags);
				await this.plugin.saveSettings();
			});
			this.popupTagDropdown = dropdown;
		});
	}

	/** 三类原生区块的开关：改完立即同步图标（关掉时才能立刻摘掉已注入的按钮）。 */
	private addBlockKindSetting(
		containerEl: HTMLElement,
		key: keyof BlockKindSettings,
		name: string,
		desc: string,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.blockKinds[key]).onChange(async (value) => {
					this.plugin.settings.blockKinds[key] = value;
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

		const describe = (value: string): string => (value ? value : t('Follow theme'));
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
			button.setButtonText(t('Follow theme')).onClick(async () => {
				this.plugin.settings[key] = '';
				await this.plugin.saveSettings();
				render('');
			}),
		);

		statusEl = setting.controlEl.createSpan({ cls: 'text-popup-setting-status' });
		render(this.plugin.settings[key]);
	}
}
