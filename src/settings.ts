import { PluginSettingTab } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';
import { isBlockLevelTag } from './blocks';
import { t } from './lang/helpers';
import type TextPopupPlugin from './main';
import { notifyQuoteActionsChanged, refreshTextPopupActions } from './scanner';
import { DEFAULT_TAGS, normalizeTagList } from './tags';

/** 七类 Obsidian 原生区块的开关；块级原始 HTML 由「支持的标签」控制，不在这里。 */
export type BlockKindSettings = Record<
	'code' | 'callout' | 'math' | 'image' | 'quote' | 'table' | 'canvas',
	boolean
>;

export interface TextPopupSettings {
	/** 是否在实时预览中显示放大图标。 */
	enabled: boolean;
	/** 弹窗内渲染块里的 HTML 与 Markdown；关闭则按纯文本显示。 */
	renderRichText: boolean;
	/** 关闭放大弹窗时，把笔记滚动到正在浏览的那个块的起始行（不移动光标，V127）。 */
	locateOnClose: boolean;
	/** 弹窗背景色；空字符串表示跟随主题。 */
	popupBackgroundColor: string;
	/** 弹窗文字颜色；空字符串表示跟随主题。 */
	popupTextColor: string;
	/** 弹窗默认字号（px）。 */
	popupFontSize: number;
	/** 被标记时触发放大的标签列表（设置页可编辑）。 */
	supportedTags: string[];
	/** 代码块 / Callout / 数学块 / 图片 / 引用块 / 表格 / Canvas 是否显示放大图标。 */
	blockKinds: BlockKindSettings;
	/** `Popup Selected Text` 包裹单行选区用的标签；必须是 supportedTags 里的块级标签。 */
	singleLineTag: string;
	/** `Popup Selected Text` 包裹多行选区（含换行）用的标签；必须是 supportedTags 里的块级标签。 */
	multiLineTag: string;
	/** 是否对 Excalidraw 嵌入走「同名 PNG/SVG 图片回退」路径（要求 Excalidraw 插件开启 Auto-export）。 */
	excalidrawImageFallback: boolean;
	/** Excalidraw 同名图片的优先格式：SVG 矢量（推荐），PNG 回退。 */
	excalidrawPreferredFormat: 'svg' | 'png';
}

/** 老 `data.json` 只有 `popupTag`（1.1.0 之前唯一的包裹标签），升级后它代表多行标签。 */
interface LegacySettings extends Partial<TextPopupSettings> {
	popupTag?: unknown;
}

export const DEFAULT_SETTINGS: TextPopupSettings = {
	enabled: true,
	renderRichText: true,
	locateOnClose: true,
	popupBackgroundColor: '',
	popupTextColor: '',
	popupFontSize: 16,
	supportedTags: [...DEFAULT_TAGS],
	blockKinds: {
		code: true,
		callout: true,
		math: true,
		image: true,
		quote: true,
		table: true,
		canvas: true,
	},
	singleLineTag: 'p',
	multiLineTag: 'div',
	excalidrawImageFallback: false,
	excalidrawPreferredFormat: 'svg',
};

/** 「跟随主题」时色块控件的备用色（`<input type=color>` 表示不了「没有颜色」）。 */
export const DEFAULT_BACKGROUND_HEX = '#2b2b2b';
export const DEFAULT_TEXT_HEX = '#dcddde';

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
		table: readBoolean(data.table, DEFAULT_SETTINGS.blockKinds.table),
		canvas: readBoolean(data.canvas, DEFAULT_SETTINGS.blockKinds.canvas),
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
		locateOnClose:
			typeof data.locateOnClose === 'boolean'
				? data.locateOnClose
				: DEFAULT_SETTINGS.locateOnClose,
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
		excalidrawImageFallback:
			typeof data.excalidrawImageFallback === 'boolean'
				? data.excalidrawImageFallback
				: DEFAULT_SETTINGS.excalidrawImageFallback,
		excalidrawPreferredFormat:
			data.excalidrawPreferredFormat === 'png' ? 'png' : 'svg',
	};
}

// ——————————————————————————————————————————————————————————————
// 声明式设置页的读 / 写 / 副作用（纯函数，单测主战场）
// ——————————————————————————————————————————————————————————————

/**
 * 设置页的控件键，与 `getSettingDefinitions()` 里的 `control.key` 一一对应（写错即编译报错）。
 * `popupBackgroundFollowTheme` / `popupTextFollowTheme` 是**虚拟键**：只算给控件用，不落进 `data.json`。
 */
export type SettingKey =
	| 'enabled'
	| 'renderRichText'
	| 'locateOnClose'
	| 'blockKinds.code'
	| 'blockKinds.callout'
	| 'blockKinds.math'
	| 'blockKinds.image'
	| 'blockKinds.quote'
	| 'blockKinds.table'
	| 'blockKinds.canvas'
	| 'popupBackgroundFollowTheme'
	| 'popupBackgroundColor'
	| 'popupTextFollowTheme'
	| 'popupTextColor'
	| 'popupFontSize'
	| 'supportedTags'
	| 'singleLineTag'
	| 'multiLineTag'
	| 'excalidrawImageFallback'
	| 'excalidrawPreferredFormat';

/** 改完某个键之后要跑的副作用 —— 单独一张表，防止「顺手多加一次全文档刷新」。 */
export type SettingEffect = 'refreshActions' | 'quoteActions' | 'rebuildDefinitions';

const NO_EFFECTS: readonly SettingEffect[] = [];

/**
 * 副作用表（照抄改造前 `display()` 里 13 个 `onChange` 的行为，不加不减）：
 * `enabled` 与 7 个 `blockKinds.*` 要立刻同步图标，`quote` 另发一次装饰集信号，
 * `supportedTags` 还要重建定义（两个下拉的选项要跟着变），其余键只保存。
 */
export function settingSideEffects(key: SettingKey): readonly SettingEffect[] {
	switch (key) {
		case 'enabled':
			return ['refreshActions', 'quoteActions'];
		case 'blockKinds.quote':
			return ['refreshActions', 'quoteActions'];
		case 'blockKinds.code':
		case 'blockKinds.callout':
		case 'blockKinds.math':
		case 'blockKinds.image':
		case 'blockKinds.table':
		case 'blockKinds.canvas':
			return ['refreshActions'];
		case 'supportedTags':
			return ['refreshActions', 'rebuildDefinitions'];
		default:
			return NO_EFFECTS;
	}
}

/** 读：给声明式控件播种；两个虚拟键的开关状态在这里算出来。 */
export function readSettingValue(settings: TextPopupSettings, key: SettingKey): unknown {
	switch (key) {
		case 'blockKinds.code':
			return settings.blockKinds.code;
		case 'blockKinds.callout':
			return settings.blockKinds.callout;
		case 'blockKinds.math':
			return settings.blockKinds.math;
		case 'blockKinds.image':
			return settings.blockKinds.image;
		case 'blockKinds.quote':
			return settings.blockKinds.quote;
		case 'blockKinds.table':
			return settings.blockKinds.table;
		case 'blockKinds.canvas':
			return settings.blockKinds.canvas;
		// 空字符串 = 跟随主题；颜色控件表示不了空值，跟随主题时就给备用色
		case 'popupBackgroundFollowTheme':
			return settings.popupBackgroundColor === '';
		case 'popupBackgroundColor':
			return settings.popupBackgroundColor || DEFAULT_BACKGROUND_HEX;
		case 'popupTextFollowTheme':
			return settings.popupTextColor === '';
		case 'popupTextColor':
			return settings.popupTextColor || DEFAULT_TEXT_HEX;
		case 'supportedTags':
			return settings.supportedTags.join(', ');
		default:
			return settings[key];
	}
}

/**
 * 写：归一化 + 落盘前的赋值（含 `blockKinds.*` 的嵌套路径与两个虚拟键）。
 * 返回**是否真的改动了设置** —— 没改动时调用方跳过保存与副作用，
 * 这样「同一个值反复提交」（例如在「支持的标签」里敲一个尾随空格）不会白白全文档刷新一次。
 */
export function writeSettingValue(
	settings: TextPopupSettings,
	key: SettingKey,
	value: unknown,
): boolean {
	switch (key) {
		case 'enabled':
			return assign(settings, 'enabled', value === true);
		case 'renderRichText':
			return assign(settings, 'renderRichText', value === true);
		case 'locateOnClose':
			return assign(settings, 'locateOnClose', value === true);
		case 'popupFontSize':
			return assign(settings, 'popupFontSize', clampFontSize(value));
		case 'multiLineTag':
			return assign(settings, 'multiLineTag', resolveMultiLineTag(value, settings.supportedTags));
		case 'singleLineTag':
			return assign(
				settings,
				'singleLineTag',
				resolveSingleLineTag(value, settings.multiLineTag, settings.supportedTags),
			);
		case 'popupBackgroundFollowTheme':
			return assign(
				settings,
				'popupBackgroundColor',
				value === true ? '' : DEFAULT_BACKGROUND_HEX,
			);
		case 'popupBackgroundColor':
			return assign(settings, 'popupBackgroundColor', readString(value, DEFAULT_BACKGROUND_HEX));
		case 'popupTextFollowTheme':
			return assign(settings, 'popupTextColor', value === true ? '' : DEFAULT_TEXT_HEX);
		case 'popupTextColor':
			return assign(settings, 'popupTextColor', readString(value, DEFAULT_TEXT_HEX));
		case 'blockKinds.code':
			return assignBlockKind(settings, 'code', value);
		case 'blockKinds.callout':
			return assignBlockKind(settings, 'callout', value);
		case 'blockKinds.math':
			return assignBlockKind(settings, 'math', value);
		case 'blockKinds.image':
			return assignBlockKind(settings, 'image', value);
		case 'blockKinds.quote':
			return assignBlockKind(settings, 'quote', value);
		case 'blockKinds.table':
			return assignBlockKind(settings, 'table', value);
		case 'blockKinds.canvas':
			return assignBlockKind(settings, 'canvas', value);
		case 'supportedTags':
			return assignSupportedTags(settings, value);
		case 'excalidrawImageFallback':
			return assign(settings, 'excalidrawImageFallback', value === true);
		case 'excalidrawPreferredFormat':
			return assign(settings, 'excalidrawPreferredFormat', value === 'png' ? 'png' : 'svg');
	}
}

/** 只在值真的变化时写入顶层字段。 */
function assign<K extends keyof TextPopupSettings>(
	settings: TextPopupSettings,
	key: K,
	value: TextPopupSettings[K],
): boolean {
	if (settings[key] === value) return false;
	settings[key] = value;
	return true;
}

function assignBlockKind(
	settings: TextPopupSettings,
	kind: keyof BlockKindSettings,
	value: unknown,
): boolean {
	const enabled = value === true;
	if (settings.blockKinds[kind] === enabled) return false;
	settings.blockKinds[kind] = enabled;
	return true;
}

/** 改「支持的标签」要顺手把两个包裹标签拉回合法值，顺序不能颠倒（见 `resolveSingleLineTag`）。 */
function assignSupportedTags(settings: TextPopupSettings, value: unknown): boolean {
	const tags = normalizeTagList(value);
	if (tags.join(',') === settings.supportedTags.join(',')) return false;
	settings.supportedTags = tags;
	const multiLineTag = resolveMultiLineTag(settings.multiLineTag, tags);
	settings.multiLineTag = multiLineTag;
	settings.singleLineTag = resolveSingleLineTag(settings.singleLineTag, multiLineTag, tags);
	return true;
}

/**
 * 包裹标签下拉的选项：只取「支持的标签」里的块级标签（行内标签生成的块不会有放大图标），
 * 但**当前值一定留在选项里** —— `DropdownComponent.setValue()` 只是 `selectEl.value = v`，
 * 值不在 `<option>` 里时下拉框会显示成空白（例如把 `div` 从支持列表里删掉之后）。
 */
export function tagDropdownOptions(
	settings: TextPopupSettings,
	key: 'singleLineTag' | 'multiLineTag',
): Record<string, string> {
	const tags = new Set([...settings.supportedTags.filter(isBlockLevelTag), settings[key]]);
	const options: Record<string, string> = {};
	for (const tag of tags) options[tag] = tag;
	return options;
}

/**
 * 设置页 —— 声明式定义（Obsidian 1.13 的 `getSettingDefinitions()`）。
 *
 * 取值 / 存值都走 `readSettingValue` / `writeSettingValue`，副作用只有 `settingSideEffects` 一张表；
 * 因此 `display()` 与手写的 DOM 同步全部不需要了（`minAppVersion` 也已提到 1.13.0）。
 */
export class TextPopupSettingTab extends PluginSettingTab {
	private plugin: TextPopupPlugin;

	constructor(app: App, plugin: TextPopupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return readSettingValue(this.plugin.settings, key as SettingKey);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settingKey = key as SettingKey;
		// 值没变就不必保存、更不必刷新图标或重建定义
		if (!writeSettingValue(this.plugin.settings, settingKey, value)) return;

		await this.plugin.saveSettings();
		for (const effect of settingSideEffects(settingKey)) {
			if (effect === 'refreshActions') refreshTextPopupActions(this.plugin);
			// 引用块的图标不归 refreshTextPopupActions 管（装饰集），要单独发一次刷新信号
			else if (effect === 'quoteActions') notifyQuoteActionsChanged(this.plugin);
			// 重跑 getSettingDefinitions：两个包裹标签下拉的选项跟着「支持的标签」变（焦点不受影响）
			else this.update();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		// 总开关关掉时把 6 个分类开关置灰（比藏起来好：设置搜索仍能找到，也能看出它们为什么点不动）
		const blockKindDisabled = (): boolean => !settings.enabled;
		// 「跟随主题」时色块行不显示；框架在每次改动后会重算 visible，所以不必手动重绘
		const backgroundFilled = (): boolean => settings.popupBackgroundColor !== '';
		const textFilled = (): boolean => settings.popupTextColor !== '';

		return [
			{
				type: 'group',
				heading: t('Magnifier icon'),
				items: [
					{
						name: t('Enable magnifier icon'),
						desc: t('Show a magnifier icon for supported blocks in Live Preview.'),
						control: { type: 'toggle', key: 'enabled' },
					},
					{
						name: t('Magnify code blocks'),
						desc: t('Show a magnifier icon for fenced code blocks in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.code', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify callouts'),
						desc: t('Show a magnifier icon for callouts in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.callout', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify math blocks'),
						desc: t('Show a magnifier icon for $$ math blocks in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.math', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify images'),
						desc: t('Show a magnifier icon for images in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.image', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify quotes'),
						desc: t('Show a magnifier icon for blockquotes in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.quote', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify tables'),
						desc: t('Show a magnifier icon for Markdown tables in Live Preview.'),
						control: { type: 'toggle', key: 'blockKinds.table', disabled: blockKindDisabled },
					},
					{
						name: t('Magnify canvases'),
						desc: t(
							'Show a magnifier icon for Canvas embeds in Live Preview, and render them as a read-only snapshot inside the popup.',
						),
						control: { type: 'toggle', key: 'blockKinds.canvas', disabled: blockKindDisabled },
					},
				],
			},
			{
				type: 'group',
				heading: t('Popup content'),
				items: [
					{
						name: t('Render HTML and Markdown'),
						desc: t(
							"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.",
						),
						control: { type: 'toggle', key: 'renderRichText' },
					},
					{
						name: t('Excalidraw image fallback'),
						desc: t(
							'Show Excalidraw embeds as same-name PNG/SVG images inside the popup. Requires Auto-export SVG and filename sync enabled in the Excalidraw plugin.',
						),
						control: { type: 'toggle', key: 'excalidrawImageFallback' },
					},
					{
						name: t('Preferred Excalidraw image format'),
						desc: t(
							'SVG is vector and scales losslessly with the popup zoom; PNG is raster. The fallback format is tried if the preferred one is missing.',
						),
						visible: (): boolean => settings.excalidrawImageFallback,
						control: {
							type: 'dropdown',
							key: 'excalidrawPreferredFormat',
							options: { svg: 'SVG', png: 'PNG' },
						},
					},
					{
						name: t('Follow the theme background'),
						control: { type: 'toggle', key: 'popupBackgroundFollowTheme' },
					},
					{
						name: t('Popup background color'),
						desc: t('Color of the popup window.'),
						visible: backgroundFilled,
						control: {
							type: 'color',
							key: 'popupBackgroundColor',
							defaultValue: DEFAULT_BACKGROUND_HEX,
						},
					},
					{
						name: t('Follow the theme text color'),
						control: { type: 'toggle', key: 'popupTextFollowTheme' },
					},
					{
						name: t('Popup text color'),
						desc: t('Text color inside the popup body.'),
						visible: textFilled,
						control: {
							type: 'color',
							key: 'popupTextColor',
							defaultValue: DEFAULT_TEXT_HEX,
						},
					},
					{
						name: t('Popup font size'),
						desc: t(
							'Default font size inside the popup, in pixels. You can also adjust it inside the popup.',
						),
						control: {
							type: 'slider',
							key: 'popupFontSize',
							min: FONT_SIZE_MIN,
							max: FONT_SIZE_MAX,
							step: FONT_SIZE_STEP,
							defaultValue: DEFAULT_SETTINGS.popupFontSize,
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('On close'),
				items: [
					{
						name: t('Locate the viewed block'),
						desc: t(
							'When you close the popup, scroll the note to the block you were viewing. The cursor is not moved.',
						),
						control: { type: 'toggle', key: 'locateOnClose' },
					},
				],
			},
			{
				type: 'group',
				heading: t('Block wrappers'),
				items: [
					{
						name: t('Supported tags'),
						desc: t(
							'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.',
						),
						control: {
							type: 'text',
							key: 'supportedTags',
							placeholder: DEFAULT_TAGS.join(', '),
						},
					},
					{
						name: t('Single-line wrapper tag'),
						desc: t(
							'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.',
						),
						control: {
							type: 'dropdown',
							key: 'singleLineTag',
							options: tagDropdownOptions(settings, 'singleLineTag'),
						},
					},
					{
						name: t('Multi-line wrapper tag'),
						desc: t(
							'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.',
						),
						control: {
							type: 'dropdown',
							key: 'multiLineTag',
							options: tagDropdownOptions(settings, 'multiLineTag'),
						},
					},
				],
			},
		];
	}
}
