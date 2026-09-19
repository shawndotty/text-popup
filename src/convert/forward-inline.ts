/**
 * 正向行内转换（Markdown 行内 → HTML 行内）。
 *
 * 三类片段分流：已知的完整标签原样透传、行内代码转 `<code>`、其余文本走强调标记 + 最小转义。
 * `[[笔记]]` / `[t](u)` / `![[img]]` / `$x$` 有意不转：留原文时弹窗的 `MarkdownRenderer`
 * 能渲染成可点击的内部链接与图片，转成裸 `<a>` 反而会丢掉交互。
 */

import { escapeText, readTag } from './shared';

/**
 * 强调标记 → HTML 的唯一一条规则（六个捕获组：粗体 ×2、斜体 ×2、高亮、删除线）。
 * 一趟扫完，不能拆成多趟：多趟之间字符串里已经出现了自己生成的标签，后一趟的转义会把它们弄坏。
 */
const EMPHASIS_SOURCE =
	/\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])|(?<!\*)\*(?=\S)([\s\S]*?\S)\*(?!\*)|(?<![\w])_(?=\S)([\s\S]*?\S)_(?![\w])|==(?=\S)([\s\S]*?\S)==|~~(?=\S)([\s\S]*?\S)~~/g;

/** 与 EMPHASIS_SOURCE 的捕获组一一对应：粗体 ×2、斜体 ×2、高亮、删除线。 */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
	['<strong>', '</strong>'],
	['<strong>', '</strong>'],
	['<em>', '</em>'],
	['<em>', '</em>'],
	['<mark>', '</mark>'],
	['<del>', '</del>'],
];

/** 把一条命中的强调标记包成 HTML，内部递归转换（`**粗 *斜* 体**` 这类嵌套也能落地）。 */
function wrapEmphasis(match: RegExpExecArray): string {
	for (let index = 0; index < WRAPPERS.length; index++) {
		const inner = match[index + 1];
		const wrapper = WRAPPERS[index];
		if (inner === undefined || !wrapper) continue;
		return `${wrapper[0]}${convertInline(inner)}${wrapper[1]}`;
	}
	return match[0];
}

/**
 * 行内转换（**只处理一行**，由 `markdownToHtml` 逐行调用）。
 */
export function convertInline(text: string): string {
	let out = '';
	let index = 0;

	while (index < text.length) {
		const char = text.charAt(index);

		if (char === '<') {
			const tag = readTag(text, index);
			if (tag) {
				out += tag.raw;
				index += tag.raw.length;
			} else {
				// 裸 `<`（如 `a < b`）：转义，避免被当成标签开头
				out += '&lt;';
				index += 1;
			}
			continue;
		}

		if (char === '`') {
			const span = readCodeSpan(text, index);
			if (span) {
				out += `<code>${escapeText(span.code)}</code>`;
				index = span.end;
				continue;
			}
			out += char;
			index += 1;
			continue;
		}

		// 普通文本片段：吃到下一个 `<` 或反引号为止
		const next = nextSpecialIndex(text, index);
		out += convertPlainRun(text.slice(index, next));
		index = next;
	}

	return out;
}

/** 下一个可能是标签或代码跨度起点的位置；没有则返回文本长度。 */
function nextSpecialIndex(text: string, from: number): number {
	for (let index = from; index < text.length; index++) {
		const char = text.charAt(index);
		if (char === '<' || char === '`') return index;
	}
	return text.length;
}

interface CodeSpan {
	code: string;
	/** 跨越到闭反引号之后的下标。 */
	end: number;
}

/** 读一个行内代码跨度；没有配对的同长度反引号串则返回 null（此时反引号当普通字符）。 */
function readCodeSpan(text: string, at: number): CodeSpan | null {
	let length = 0;
	while (text.charAt(at + length) === '`') length += 1;
	const marker = '`'.repeat(length);
	const close = text.indexOf(marker, at + length);
	if (close < 0) return null;
	return { code: text.slice(at + length, close), end: close + length };
}

/** 普通文本片段：强调标记转 HTML，其余部分最小转义。 */
function convertPlainRun(text: string): string {
	// 每次新建：内部会递归调用本函数，共用一个 g 正则会互相踩 lastIndex
	const pattern = new RegExp(EMPHASIS_SOURCE.source, 'g');
	let out = '';
	let index = 0;
	let match = pattern.exec(text);

	while (match) {
		out += escapeText(text.slice(index, match.index));
		out += wrapEmphasis(match);
		index = match.index + match[0].length;
		match = pattern.exec(text);
	}

	return out + escapeText(text.slice(index));
}
