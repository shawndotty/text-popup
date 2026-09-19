/**
 * 正向标题：Markdown ATX 标题 → HTML `<h1>`–`<h6>`。
 *
 * 标题的失效方式与列表 / 表格不同：它**不**是「两边都不成立」，而是**把同一行的后续内容吃进标题**。
 * `## Test Heading` 与后文被 `<br>` 压成一行后，`##` 的作用范围是「到本行结束」，而 `<br>` 只是行内
 * 元素 —— 弹窗里于是只剩一个 `h2`，后文全变成标题文字（编辑器里则多显示一个 `##`，两头都不对）。
 * 所以标题从「有意不转」名单里移出来，进入列表 / 表格那一类：转成真正的 HTML 标题，压在正文那一行里。
 */

import { convertInline } from './forward-inline';
import { hasCodeIndent } from './shared';

/** 一行原文切片成的 ATX 标题；不是标题行时 `matchHeading` 返回 null。 */
interface HeadingLine {
	/** 1–6。 */
	level: number;
	/** 标题文字（已去掉标记、尾部闭合串与两侧空白）。 */
	content: string;
}

/**
 * 从一行原文里认出 ATX 标题；判据逐条对齐核心，**宁可漏判也不误判**：
 *
 * - 缩进 ≥4 / 含 Tab（`hasCodeIndent`）是缩进代码块，不是标题；
 * - `^ {0,3}(#{1,6})(?=[ \t]|$)`：0–3 个前导空格、1–6 个 `#`、`#` 后必须是空白或行尾 ——
 *   7 个 `#`、`#nospace` 因此天然不命中；
 * - 尾部闭合串（**空白引出**的纯 `#` 串，如 `## T ##`）去掉；`# T#` / `# T \#` 因缺少那个空白而不算
 *   闭合串，整段留在标题文字里；
 * - 空的 `#` / `###` 是合法标题（内容为空）。
 */
export function matchHeading(line: string): HeadingLine | null {
	if (hasCodeIndent(line)) return null;

	const match = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
	const marker = match?.[1];
	if (!marker) return null;

	const content = line
		.slice(match[0].length)
		.replace(/[ \t]+#+[ \t]*$/, '')
		.trim();

	return { level: marker.length, content };
}

/**
 * 标题 → HTML。markup **不带任何属性**：核心自己在 HTML 块里的标题也不带（弹窗里那个 `dir="auto"`
 * 是渲染器加的、不是源码里的），而属性会成为反向时「Markdown 表达不了」的整段保留判据。
 * 标题文字走 `convertInline`，与列表项、表格单元格同一条路。
 */
export function renderHeading(heading: HeadingLine): string {
	return `<h${heading.level}>${convertInline(heading.content)}</h${heading.level}>`;
}
