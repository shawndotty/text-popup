import { WIKI_EMBED } from './blocks';
import { matchTable } from './convert/forward-table';

/**
 * 从被标记的元素里取出用于放大的纯文本。
 *
 * - 优先 innerText：保留 `<br>` 与块级元素造成的换行，符合「原样放大」的语义。
 * - 回退 textContent：元素处于隐藏 / 未布局状态时 innerText 可能为空。
 * - 折叠 3 个以上连续换行：抵消 HTML 源码缩进带来的空行堆积。
 */
export function extractText(el: HTMLElement): string {
	const raw = (el.innerText ?? '').trim() || (el.textContent ?? '').trim();
	return raw.replace(/\n{3,}/g, '\n\n');
}

/** 核心在块内可能注入的非内容节点，不剔除会在弹窗里留下零宽占位与重复按钮。 */
const INJECTED_SELECTOR = '.cm-widgetBuffer, .edit-block-button, .copy-code-button';

/**
 * 富文本渲染的输入：块级 HTML 块的内容（去掉外层容器标签）+ 去缩进。
 *
 * 为什么去掉外层标签：直接把 outerHTML 交给 Markdown 渲染器时，字符串以 `<div>` 开头，
 * 会被按 CommonMark 的 HTML block 规则整段吞掉，块内的 `**粗体**` 依然不解析。去掉后
 * 字符串以普通文本或行内标签开头，内嵌的 `<span>` / `<table>` / `<img>` 照常透传。
 *
 * 为什么必须去缩进：块在源码里通常整体缩进，innerHTML 会把缩进原样带出；
 * Markdown 中 4 个及以上前导空格 = 代码块，不去缩进会把正常文字渲染成代码块。
 */
export function extractRichSource(el: HTMLElement): string {
	const clone = el.cloneNode(true) as HTMLElement;
	clone.querySelectorAll(INJECTED_SELECTOR).forEach((node) => node.remove());
	clone.removeAttribute('contenteditable');
	clone.removeAttribute('spellcheck');
	return dedent(clone.innerHTML);
}

/**
 * 围栏代码块的正文：去掉开围栏行（含 info string）与闭围栏行。
 *
 * 只用于「关闭富文本渲染」时的纯文本回退；打开时弹窗直接回灌区间原文，
 * 交给 `MarkdownRenderer` 渲染成带语法高亮的代码块。
 */
export function extractFencedBody(raw: string): string {
	const lines = raw.split('\n');
	if (lines.length > 1 && FENCE_OPEN.test(lines[0] ?? '')) lines.shift();
	if (lines.length > 0 && FENCE_ONLY.test(lines[lines.length - 1] ?? '')) lines.pop();
	return lines.join('\n').trim();
}

/** 开围栏：3 个及以上反引号或波浪号（后面可以跟 info string）。 */
const FENCE_OPEN = /^ {0,3}(?:`{3,}|~{3,})/;
/** 独占一行的围栏：闭围栏的形态。 */
const FENCE_ONLY = /^ {0,3}(?:`{3,}|~{3,})\s*$/;

/**
 * 引用块与 Callout 共用：去掉每行的 `> ` 前缀（只去一层，嵌套的 `> > ` 保留内层）。
 *
 * 前导空格上限与 `blocks.ts` 的 `QUOTE_LINE` 对齐（≤3 个），4 空格缩进的 `>` 属于缩进代码块。
 */
function stripQuotePrefix(raw: string): string {
	return raw
		.split('\n')
		.map((line) => line.replace(/^ {0,3}> ?/, ''))
		.join('\n');
}

/**
 * 引用块的正文：只去 `> ` 前缀，不剥 `[!TYPE]`。
 *
 * 与 `extractCalloutBody` 分开是有意的：`> [!note] x` 这种写法在扫描器里是 **Callout**
 * （`matchCallout` 先命中），只有真的走到引用块才会用这里 —— 此时 `[!note]` 是用户想看的原文。
 */
export function extractQuoteBody(raw: string): string {
	return stripQuotePrefix(raw).trim();
}

/**
 * Callout 的正文：去掉每行的 `> ` 前缀，再去掉首行的 `[!TYPE]` 标记（保留标题文字）。
 *
 * 标题行保留是有意为之：点开 Callout 通常也要看标题；想只看正文可关闭「渲染 HTML 与 Markdown」。
 */
export function extractCalloutBody(raw: string): string {
	const lines = stripQuotePrefix(raw).split('\n');
	if (lines.length > 0) lines[0] = (lines[0] ?? '').replace(/^\[![^\]]+\][+-]?\s*/, '');
	return lines.join('\n').trim();
}

/** 数学块的 TeX 源码：去掉 `$$` 定界符。 */
export function extractMathBody(raw: string): string {
	return raw.replace(/\$\$/g, '').trim();
}

/**
 * 图片的纯文本回退：取 alt / 文件名，让「关闭富文本渲染」时仍看得出是哪张图。
 *
 * 两种写法的「第二段」含义不同，按 Obsidian 的约定处理：
 * `![[p.png|100]]` 的第二段是尺寸（数字），`![[p.png|图注]]` 才是 alt；
 * `![alt|120](url)` 里 `|` 之后是尺寸，alt 在 `[]` 里。
 */
export function extractImageBody(raw: string): string {
	const wiki = WIKI_EMBED.exec(raw);
	if (wiki) {
		const parts = (wiki[1] ?? '').split('|').map((part) => part.trim());
		const alt = parts.slice(1).find((part) => part && !/^\d+(x\d+)?$/.test(part));
		return alt ?? parts[0] ?? raw;
	}
	const alt = /^!\[([^\]\n]*)\]/.exec(raw)?.[1]?.split('|')[0]?.trim();
	return alt || raw;
}

/**
 * 表格的纯文本回退：去掉首尾空行后**返回原文**，保留 `|` 网格。
 *
 * 与另外五类的取舍不同：它们剥掉的是「纯语法噪音」（围栏 / `> ` / `$$`），而表格的 `|` 网格
 * 本身就是可读内容 —— 要剥就得重排对齐列宽，收益低、易出 bug；原文在任何编辑器里都读得通。
 *
 * 唯一例外是「一眼空」的表（只有表头行 + 分隔行、且表头每格都空）：返回空串让候选被丢掉
 * （`createCandidate` 见空即 null），与「只有 `> ` 的空引用块不产候选」同一口径 —— 否则点开
 * 图标会是一屏空白。判据复用 `matchTable`，不另写一份解析。
 */
export function extractTableBody(raw: string): string {
	const lines = raw.split('\n');
	while (lines.length > 0 && !(lines[0] ?? '').trim()) lines.shift();
	while (lines.length > 0 && !(lines[lines.length - 1] ?? '').trim()) lines.pop();

	// start = 0 时 matchTable 跳过「必须起一个块」那条（区间本来就是从块首切出来的）
	const table = matchTable(lines, 0);
	if (table && table.rows.length === 0 && table.header.every((cell) => cell.trim() === '')) {
		return '';
	}
	return lines.join('\n');
}

/** 去首尾空行 + 按最小缩进整体左移（只左移，不吞内容）。 */
function dedent(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	while (lines.length > 0 && !(lines[0] ?? '').trim()) lines.shift();
	while (lines.length > 0 && !(lines[lines.length - 1] ?? '').trim()) lines.pop();
	const indents = lines
		.filter((line) => line.trim())
		.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
	const min = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((line) => line.slice(min)).join('\n');
}
