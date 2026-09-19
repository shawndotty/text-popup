/**
 * 两个转换命令 + 一个打开命令 + 编辑器右键菜单项 —— 「取选区 → 守卫 → 转换 → 写回」的入口层。
 *
 * 命令与菜单项共用 `popupSelection` / `unpopupSelection`，单一实现、两个入口，行为不会漂移。
 * `Show Popup In The Note` 不进右键菜单（它不需要选区，菜单里也没有对应的上下文）。
 *
 * 为什么右键菜单要自己挂：核心只把带 `editorCallback` / `editorCheckCallback` 的命令登记进
 * `editorCommands` 表，而那张表只被移动端工具栏读取（已对照本机 `obsidian.asar` 的 `app.js`），
 * 不会自动列进编辑器右键菜单 —— 必须显式监听 `editor-menu` 再 `menu.addItem()`。
 */

import { Notice } from 'obsidian';
import type { App, Command, Editor, EventRef } from 'obsidian';
import { isBlockLevelTag, scanTextBlocks } from './blocks';
import type { TextBlockRegion } from './blocks';
import { findOuterPopupElement, hasBlockBody, hasTooDeepIndent, htmlToMarkdown, isSingleLine, markdownToHtml } from './convert';
import { t } from './lang/helpers';
import { openFirstTextPopup } from './scanner';
import type { TextPopupSettings } from './settings';

/** 命令层只需要插件的这几项能力，避免与 main.ts 形成循环依赖（与 scanner.ts 的 TextPopupHost 同一手法）。 */
export interface CommandHost {
	app: App;
	settings: TextPopupSettings;
	addCommand(command: Command): Command;
	registerEvent(eventRef: EventRef): void;
}

/** 注册两个转换命令与右键菜单项；清理交给 `addCommand` / `registerEvent`。 */
export function registerCommands(host: CommandHost): void {
	// 用 editorCheckCallback 而不是 editorCallback：没有选区时命令在命令面板里直接灰掉。
	// 顺带白拿核心合成的 checkCallback 守卫：没有活动编辑器 / 阅读视图 / 焦点在标题或属性区都不触发。
	host.addCommand({
		id: 'popup-selected-text',
		name: t('Popup selected text'),
		icon: 'maximize-2',
		editorCheckCallback: (checking, editor) => {
			if (!editor.somethingSelected()) return false;
			if (!checking) popupSelection(host, editor);
			return true;
		},
	});

	host.addCommand({
		id: 'unpopup-selected-text',
		name: t('Unpopup selected text'),
		icon: 'minimize-2',
		editorCheckCallback: (checking, editor) => {
			if (!editor.somethingSelected()) return false;
			if (!checking) unpopupSelection(host, editor);
			return true;
		},
	});

	// 只要在编辑视图里就可用（不做「笔记里有 Popup」这类判定：那要在命令面板每次刷新时扫全文，
	// 代价与收益不成比例）。editorCheckCallback 恒返回 true 的另一个好处是白拿核心合成的守卫：
	// 阅读视图、没有活动编辑器、焦点在标题 / 属性区都不会触发。
	host.addCommand({
		id: 'show-popup-in-the-note',
		name: t('Show Popup In The Note'),
		icon: 'maximize-2',
		editorCheckCallback: (checking, editor) => {
			if (!checking) showFirstPopup(host, editor);
			return true;
		},
	});

	// 没有选区时不加这两项，避免给右键菜单添噪音；`selection` 段落在「打开」之后、剪贴板之前。
	host.registerEvent(
		host.app.workspace.on('editor-menu', (menu, editor) => {
			if (!editor.somethingSelected()) return;
			menu.addItem((item) => {
				item.setTitle(t('Popup selected text'))
					.setIcon('maximize-2')
					.setSection('selection')
					.onClick(() => popupSelection(host, editor));
			});
			menu.addItem((item) => {
				item.setTitle(t('Unpopup selected text'))
					.setIcon('minimize-2')
					.setSection('selection')
					.onClick(() => unpopupSelection(host, editor));
			});
		}),
	);
}

/**
 * Show Popup In The Note：直接打开当前笔记里的第一个可放大区块；一个都没有时提示用户。
 *
 * 候选集与「点放大图标」那条路径同源（见 `scanner.ts` 的 `openFirstTextPopup`），
 * 所以提示的「没有」与方向键能翻到的条目永远一致。命令不改笔记、不改设置，只读 + 开弹窗。
 */
function showFirstPopup(host: CommandHost, editor: Editor): void {
	if (!openFirstTextPopup(host, editor)) {
		new Notice(t('No popup in the current note.'));
	}
}

/** Popup：把选中的 Markdown 文本转成可放大的 HTML 块。 */
function popupSelection(host: CommandHost, editor: Editor): void {
	if (editor.listSelections().length > 1) {
		new Notice(t('Please use a single cursor.'));
		return;
	}

	const range = readSelectedLines(editor);
	const text = editor.getRange(range.from, range.to);
	if (!text.trim()) {
		new Notice(t('The selection is empty; nothing to convert.'));
		return;
	}
	if (hasTooDeepIndent(text)) {
		new Notice(t('The selection is indented too deeply and would be treated as a code block.'));
		return;
	}

	// 在围栏里塞标签只会变成字面文本；Callout 每行还要补 `>` 前缀。一律拒绝，且一个字节都不改。
	// 图片**不是**「容器」类：选区里有一行 `![x](p.png)` 照常转换（这一行以前压根不在候选里，
	// 不把它排除就是本次改动引入的回归）。
	const clash = scanTextBlocks(editor.getValue()).find(
		(region) => region.kind !== 'image' && overlaps(region, range.from.line, range.to.line),
	);
	if (clash && clash.kind !== 'html') {
		new Notice(t('The selection is inside a code block, callout, or math block.'));
		return;
	}
	if (clash) {
		new Notice(t('The selection already contains a popup block; use the unpopup command first.'));
		return;
	}

	// 标签依赖已取到的选区文本：单行 / 多行各取一个设置项，不合法时按同一套判据拒绝。
	// 正文含块级元素（列表 / 标题）时按多行走：`p` 遇到 `<ul>` / `<hN>` 会被解析器自动闭合、
	// 再补一个空 `p` → 块没有放大图标（幽灵块）。
	const blockBody = hasBlockBody(text);
	const tag = resolvePopupTag(host.settings, isSingleLine(text) && !blockBody, blockBody);
	if (!tag) {
		new Notice(t('Wrapper tag unavailable. Check the wrapper tag settings and "Supported tags".'));
		return;
	}

	const block = markdownToHtml(text, tag);
	// HTML 块到第一个空行才结束：`</T>` 后面紧邻非空行时补一个换行，否则那些行会被吃进块里
	const insert = needsBlankLineAfter(editor, range.to.line) ? `${block}\n` : block;
	editor.replaceRange(insert, range.from, range.to);
}

/** Unpopup：去掉外层标签，并把块内的 HTML 还原成 Obsidian 支持的 Markdown。 */
function unpopupSelection(host: CommandHost, editor: Editor): void {
	if (editor.listSelections().length > 1) {
		new Notice(t('Please use a single cursor.'));
		return;
	}

	const range = readSelectedLines(editor);
	const hits = scanTextBlocks(editor.getValue()).filter(
		(region) => region.kind === 'html' && overlaps(region, range.from.line, range.to.line),
	);
	if (hits.length === 0) {
		new Notice(t('The selection is not inside a magnifiable HTML block.'));
		return;
	}
	if (hits.length > 1) {
		new Notice(t('The selection spans multiple popup blocks; only one can be restored at a time.'));
		return;
	}

	const region = hits[0];
	if (!region) return;

	const element = findOuterPopupElement(region.raw, host.settings.supportedTags);
	if (!element) {
		new Notice(
			t(
				'No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.',
			),
		);
		return;
	}

	// 只替换 `<T>…</T>` 这一段：区间里被「块到空行为止」顺带吃进来的后文原样留在块外
	const offset = lineStartOffset(editor.getValue(), region.startLine);
	editor.replaceRange(
		htmlToMarkdown(element.inner),
		editor.offsetToPos(offset + element.start),
		editor.offsetToPos(offset + element.end),
	);
}

interface LineRange {
	from: { line: number; ch: number };
	to: { line: number; ch: number };
}

/**
 * 选区对应的**整行**范围：`<T>` 必须落在行首，半行选区（选到行中间）没有任何意义。
 * 末尾正好落在行首时，这一行其实没被选中，要退回去。
 */
function readSelectedLines(editor: Editor): LineRange {
	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	const endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
	return {
		from: { line: from.line, ch: 0 },
		to: { line: endLine, ch: editor.getLine(endLine).length },
	};
}

/** 选区行范围与某个区间是否相交。 */
function overlaps(region: TextBlockRegion, startLine: number, endLine: number): boolean {
	return region.startLine <= endLine && region.endLine >= startLine;
}

/** `</T>` 的下一行不存在（文末）或已是空行时不用补；否则必须补一个换行造出空行。 */
function needsBlankLineAfter(editor: Editor, endLine: number): boolean {
	const nextLine = endLine + 1;
	return nextLine <= editor.lastLine() && editor.getLine(nextLine).trim() !== '';
}

/** 第 `line` 行（0 起）在全文里的起始偏移。 */
function lineStartOffset(text: string, line: number): number {
	let offset = 0;
	for (let index = 0; index < line; index++) {
		const next = text.indexOf('\n', offset);
		if (next < 0) return text.length;
		offset = next + 1;
	}
	return offset;
}

/**
 * 包裹标签必须同时是块级标签、且在「支持的标签」里，否则块不会生成、或生成了也没有放大图标。
 * 按选区是否为单行取对应的设置项（单行选中 `singleLineTag`，含换行选中 `multiLineTag`）。
 *
 * `hasBlock`（正文里会出现块级元素：列表 / 标题）时把 `p` 判为不合法：解析器遇到 `<ul>` / `<hN>`
 * 会自动闭合未闭合的 `<p>` 并补出一个空 `<p>`，`findSupportedElement` 命中的正是那个空元素 →
 * 块没有放大图标（幽灵块）。
 * 即便你把多行标签**显式**设成 `p`，这里也只让命令层弹一次既有文案的 Notice、一个字节都不改。
 */
function resolvePopupTag(settings: TextPopupSettings, singleLine: boolean, hasBlock = false): string | null {
	const tag = singleLine ? settings.singleLineTag : settings.multiLineTag;
	if (!tag || !isBlockLevelTag(tag) || !settings.supportedTags.includes(tag)) return null;
	return hasBlock && tag.trim().toLowerCase() === 'p' ? null : tag;
}
