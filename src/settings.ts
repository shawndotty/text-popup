import { App, PluginSettingTab, Setting } from 'obsidian';
import type { DropdownComponent } from 'obsidian';
import { isBlockLevelTag } from './blocks';
import { t } from './lang/helpers';
import type TextPopupPlugin from './main';
import { notifyQuoteActionsChanged, refreshTextPopupActions } from './scanner';
import { DEFAULT_TAGS, normalizeTagList } from './tags';

/** 五类 Obsidian 原生区块的开关；块级原始 HTML 由「支持的标签」控制，不在这里。 */
export type BlockKindSettings = Record<'code' | 'callout' | 'math' | 'image' | 'quote', boolean>;

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
	/** 代码块 / Callout / 数学块 / 图片 / 引用块是否显示放大图标。 */
	blockKinds: BlockKindSettings;
	/** `Popup Selected Text` 包裹单行选区用的标签；必须是 supportedTags 里的块级标签。 */
	singleLineTag: string;
	/** `Popup Selected Text` 包裹多行选区（含换行）用的标签；必须是 supportedTags 里的块级标签。 */
	multiLineTag: string;
}

/** 老 `data.json` 只有 `popupTag`（1.1.0 之前唯一的包裹标签），升级后它代表多行标签。 */
interface LegacySettings extends Partial<TextPopupSettings> {
	popupTag?: unknown;
}

export const DEFAULT_SETTINGS: TextPopupSettings = {
	enabled: true,
	renderRichText: true,
	popupBackgroundColor: '',
	popupTextColor: '',
	popupFontSize: 16,
	supportedTags: [...DEFAULT_TAGS],
	blockKinds: { code: true, callout: true, math: true, image: true, quote: true },
	singleLineTag: 'p',
	multiLineTag: 'div',
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
		image: readBoolean(data.image, DEFAULT_SETTINGS.blockKinds.image),
		quote: readBoolean(data.quote, DEFAULT_SETTINGS.blockKinds.quote),
	};
}

/**
 * 多行包裹标签的约束式回落：必须同时「在支持列表里」与「是块级标签」才采纳，
 * 否则取支持列表里第一个块级标签（列表里没有块级标签时回落到默认的 `div`）。
 * 老 `data.json` 没有这个字段 → 自动补齐，不需要迁移脚本。
 */
export function resolveMultiLineTag(tag: unknown, supportedTags: readonly string[]): string {
	const blockTags = supportedTags.filter(isBlockLevelTag);
	if (typeof tag === 'string' && blockTags.includes(tag)) return tag;
	return blockTags[0] ?? DEFAULT_SETTINGS.multiLineTag;
}

/**
 * 单行包裹标签的约束式回落，判据与 `resolveMultiLineTag` 完全相同（非空字符串 + 块级 + 在支持列表里）。
 * 依次尝试「存值 → 默认 `p` → 多行标签 → 支持列表里第一个块级标签」，全不合法时回落到默认 `div`。
 * 多行标签排在里面，是为了让「把 `p` 从支持列表删掉」时单行自动退回旧行为（等价于 1.1.0 之前）。
 * **调用方必须先落定多行标签**（回落链依赖它）。
 */
export function resolveSingleLineTag(
	value: unknown,
	multiLineTag: string,
	supportedTags: readonly string[],
): string {
	const blockTags = supportedTags.filter(isBlockLevelTag);
	const candidates = [value, DEFAULT_SETTINGS.singleLineTag, multiLineTag, ...blockTags];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && blockTags.includes(candidate)) return candidate;
	}
	return DEFAULT_SETTINGS.multiLineTag;
}

/** 把磁盘上可能残缺 / 过期的数据整理成一份完整设置。 */
export function normalizeSettings(raw: unknown): TextPopupSettings {
	const data = (raw ?? {}) as LegacySettings;
	const supportedTags = normalizeTagList(data.supportedTags);
	// 顺序不能颠倒：单行的兜底依赖多行先落定。
	const multiLineTag = resolveMultiLineTag(data.multiLineTag ?? data.popupTag, supportedTags);
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
		singleLineTag: resolveSingleLineTag(data.singleLineTag, multiLineTag, supportedTags),
		multiLineTag,
	};
}

export class TextPopupSettingTab extends PluginSettingTab {
	private plugin: TextPopupPlugin;
	/** 两个包裹标签下拉框；「支持的标签」改动把它们挤掉时用它同步显示，不整页重绘。 */
	private tagDropdowns: Array<{ dropdown: DropdownComponent; key: 'singleLineTag' | 'multiLineTag' }> =
		[];

	constructor(app: App, plugin: TextPopupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// 整页重绘会丢弃旧的下拉框节点，引用一并清空
		this.tagDropdowns = [];

		new Setting(containerEl)
			.setName(t('Enable magnifier icon'))
			.setDesc(t('Show a magnifier icon for supported blocks in Live Preview.'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					refreshTextPopupActions(this.plugin);
					// 引用块的图标不归 refreshTextPopupActions 管（装饰集），要单独发一次刷新信号
					notifyQuoteActionsChanged(this.plugin);
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
		this.addBlockKindSetting(
			containerEl,
			'image',
			t('Magnify images'),
			t('Show a magnifier icon for images in Live Preview.'),
		);
		this.addBlockKindSetting(
			containerEl,
			'quote',
			t('Magnify quotes'),
			t('Show a magnifier icon for blockquotes in Live Preview.'),
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
						// 顺序不能颠倒：单行的兜底链依赖多行先落定。
						// 不整页重绘：那会让正在输入的这个文本框失焦。
						const multiLineTag = resolveMultiLineTag(this.plugin.settings.multiLineTag, tags);
						const singleLineTag = resolveSingleLineTag(
							this.plugin.settings.singleLineTag,
							multiLineTag,
							tags,
						);
						this.plugin.settings.multiLineTag = multiLineTag;
						this.plugin.settings.singleLineTag = singleLineTag;
						this.syncTagDropdowns();
						await this.plugin.saveSettings();
						refreshTextPopupActions(this.plugin);
					}),
			);

		this.addTagSetting(
			containerEl,
			'singleLineTag',
			t('Single-line wrapper tag'),
			t(
				'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.',
			),
		);
		this.addTagSetting(
			containerEl,
			'multiLineTag',
			t('Multi-line wrapper tag'),
			t(
				'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.',
			),
		);
	}

	/** 把设置里的两个包裹标签推回下拉框（「支持的标签」改动后调用）。 */
	private syncTagDropdowns(): void {
		for (const { dropdown, key } of this.tagDropdowns) {
			dropdown.setValue(this.plugin.settings[key]);
		}
	}

	/**
	 * 包裹标签：`Popup Selected Text` 生成块时用的外层标签（单行 / 多行各一个）。
	 * 选项只取「支持的标签」里的块级标签 —— 行内标签（`span` 等）生成的块不会有放大图标。
	 */
	private addTagSetting(
		containerEl: HTMLElement,
		key: 'singleLineTag' | 'multiLineTag',
		name: string,
		desc: string,
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);

		setting.addDropdown((dropdown) => {
			// 当前值一定留在选项里：否则 supportedTags 被改空后下拉框会显示成空白
			const tags = new Set([
				...this.plugin.settings.supportedTags.filter(isBlockLevelTag),
				this.plugin.settings[key],
			]);
			for (const tag of tags) dropdown.addOption(tag, tag);
			dropdown.setValue(this.plugin.settings[key]).onChange(async (value) => {
				if (key === 'multiLineTag') {
					this.plugin.settings.multiLineTag = resolveMultiLineTag(
						value,
						this.plugin.settings.supportedTags,
					);
				} else {
					this.plugin.settings.singleLineTag = resolveSingleLineTag(
						value,
						this.plugin.settings.multiLineTag,
						this.plugin.settings.supportedTags,
					);
				}
				await this.plugin.saveSettings();
			});
			this.tagDropdowns.push({ dropdown, key });
		});
	}

	/**
	 * 五类原生区块的开关：改完立即同步图标（关掉时才能立刻摘掉已注入的按钮）。
	 *
	 * 引用块不在 `refreshTextPopupActions` 的覆盖范围里（它的图标由 CM6 装饰器托管），
	 * 只有它的开关需要额外发一次刷新信号；别的类别不必为此重建装饰集。
	 */
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
					if (key === 'quote') notifyQuoteActionsChanged(this.plugin);
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
