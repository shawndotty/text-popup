/**
 * convert 模块的共享原语：换行归一化、HTML 标签读取、最小转义 / 反查、代码块缩进判定。
 *
 * 正向与反向两条路径都依赖这里，单独抽出避免互相 import。
 */

/** 换行符归一化：CRLF / CR → LF（选区来自编辑器，换行符统一后才能按 `\n` 切行）。 */
export function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** 完整 HTML 标签：`<div>`、`</div>`、`<span class="x">`、`<br/>`。匹配不上的一律当普通 `<`。 */
export const HTML_TAG = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;

/** 从标签原文里取标签名（小写）。 */
export const TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;

export interface TagToken {
	/** 标签名，小写。 */
	name: string;
	/** 是否为闭标签（`</tag>`）。 */
	closing: boolean;
	/** 标签原文，原样透传时用它。 */
	raw: string;
}

/**
 * 从 `text[at]`（调用方保证是 `<`）起读一个完整标签。
 * 不是完整标签（如 `a < b` 里的裸 `<`）则返回 null，由调用方按内容转义。
 */
export function readTag(text: string, at: number): TagToken | null {
	const raw = HTML_TAG.exec(text.slice(at))?.[0];
	if (!raw) return null;
	const name = TAG_NAME.exec(raw)?.[1]?.toLowerCase();
	if (!name) return null;
	return { name, closing: raw.startsWith('</'), raw };
}

/**
 * 最小转义：只处理「会被 HTML 解析器误读」的两种字符。
 *
 * - `&` 后面跟着形如实体的片段 → `&amp;`（`AT&T` 这类普通 `&` 不动）；
 * - `<` → `&lt;`（只用在代码跨度里：正文里的裸 `<` 由调用方单独处理，完整标签则原样透传）。
 *
 * 宁可不转义，也不要为了洁癖把用户已有的内容改脏；`htmlToMarkdown` 侧按同一张表还原。
 */
export function escapeText(text: string): string {
	return text
		.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, '&amp;')
		.replace(/</g, '&lt;');
}

/**
 * 属性值转义：写进 `href` 前把会被 HTML 解析器误读的四个字符全转掉。
 *
 * 与 `escapeText` 分开：这里不能「宁可不转」（属性值里的 `&` / `"` 会截断属性或改变 URL），
 * 必须四个字符都处理；反向由 `readHref` 的 `decodeEntities` 还原（`"` 因此要在反查表里）。
 */
export function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 转义表反查；单趟 `replace` 保证 `&amp;lt;` 不会被折叠两级。 */
export const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"' };

export function decodeEntities(text: string): string {
	return text.replace(/&(lt|gt|amp|quot);/gi, (match: string, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/** 表格对齐；`null` = 没指定（Markdown 的分隔行不写冒号）。 */
export type TableAlign = 'left' | 'center' | 'right';

/** 缩进 ≥4 个空格（或含制表符）就是代码块，表格 / 分隔行在那里都不成立。 */
export function hasCodeIndent(line: string): boolean {
	const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
	return leading.includes('\t') || leading.length >= 4;
}
