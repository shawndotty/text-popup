/**
 * Markdown ↔ HTML 转换的纯函数层 —— `Popup Selected Text` / `Unpopup Selected Text` 的算法都在这里。
 *
 * 刻意不 import obsidian：这两个方向的转换可以脱离 Obsidian 运行，往返回合能用一次性脚本直接验证。
 *
 * 生成格式（本文件所有细节都服务于它）：
 *
 *   <div>
 *   第一段第一行<br>第一段第二行<br><br>第二段
 *   </div>
 *
 * 两条来自既有实现的硬约束：
 * - **块里不能有空行**：块级原始 HTML 到第一个空行就结束（`blocks.ts` 的 `matchHtmlBlock`），
 *   一旦生成空行，块会被截断、后半段掉出弹窗。正文写成**独占一行的单行**，结构上不可能有空行。
 * - **正文里的行结构不能用 `<p>`**：`<p><p>a</p><p>b</p></p>` 会被 HTML 解析器拆开，
 *   `findSupportedElement`（`tags.ts`）命中的是第一个空 `<p>`，`hasContent` 为假 → 块直接不算候选。
 *   用 `<br>` 表达换行，则 `div` / `p` / `section` 等任意块级标签都是合法嵌套。
 *
 * 注意区分上面第二条与**外层标签**：外层标签用 `p`（单行选区的默认值）是合法的 ——
 * 它的正文要么是单行纯文本（不含任何 `<br>`），要么用 `<br>` 表达换行，都不涉及「正文里拿 `<p>` 当行结构」。
 *
 * 为什么 `<br>` 后面**不**跟源码换行：弹窗的富文本渲染走 `MarkdownRenderer`，而本库的
 * 「严格换行」是关的 —— 一个软换行也会渲染成 `<br>`。于是 `A<br>\nB` 在弹窗里会变成
 * **两个**换行（`A`、空行、`B`），`A<br>\n<br>\nB` 更是变成两个空行，与原文不符（实测见报告）。
 * 正文压在单行后，`A<br>B` → 1 个换行、`A<br><br>B` → 1 个空行，富文本与纯文本两条路径结果一致。
 */

/** 换行符归一化：CRLF / CR → LF（选区来自编辑器，换行符统一后才能按 `\n` 切行）。 */
function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** 完整 HTML 标签：`<div>`、`</div>`、`<span class="x">`、`<br/>`。匹配不上的一律当普通 `<`。 */
const HTML_TAG = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;

/** 从标签原文里取标签名（小写）。 */
const TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;

interface TagToken {
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
function readTag(text: string, at: number): TagToken | null {
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
function escapeText(text: string): string {
	return text
		.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, '&amp;')
		.replace(/</g, '&lt;');
}

/** 转义表反查；单趟 `replace` 保证 `&amp;lt;` 不会被折叠两级。 */
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&' };

function decodeEntities(text: string): string {
	return text.replace(/&(lt|gt|amp);/gi, (match: string, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

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
 *
 * 三类片段分流：已知的完整标签原样透传、行内代码转 `<code>`、其余文本走强调标记 + 最小转义。
 * `[[笔记]]` / `[t](u)` / `![[img]]` / `$x$` 有意不转：留原文时弹窗的 `MarkdownRenderer`
 * 能渲染成可点击的内部链接与图片，转成裸 `<a>` 反而会丢掉交互。
 */
function convertInline(text: string): string {
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

/**
 * 开标签后的行首缩进上限：再深就会被当成缩进代码块，`matchBlockTag`（`blocks.ts`）不再认它，
 * 块根本不会生成。因此缩进过深时命令层直接拒绝，而不是生成一个没图标的块。
 */
export const MAX_POPUP_INDENT = 3;

/** 首行缩进是否过深（含制表符）。 */
export function hasTooDeepIndent(text: string): boolean {
	const indent = /^[ \t]*/.exec(text.split('\n')[0] ?? '')?.[0] ?? '';
	return indent.includes('\t') || indent.length > MAX_POPUP_INDENT;
}

/**
 * Popup 的正文行：归一化换行、丢掉选区末尾的空行。
 * `markdownToHtml` 与 `isSingleLine` 共用它，判定与生成不会漂移。
 * 返回的是新数组，调用方不要再改写它。
 */
function bodyLines(text: string): string[] {
	const lines = normalizeNewlines(text).split('\n');
	while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * 选区是否为「单行」——也就是生成的正文里不会出现 `<br>`。
 *
 * 定义落在生成结果上而不是「字符串里含不含 `\n`」：编辑器选到行尾时常常多带一个换行，
 * 而那个换行本来就会被丢掉，按字面判定会让这些输入拿到多行标签、与生成结果自相矛盾。
 * 不变量：`isSingleLine(x)` ⇔ `markdownToHtml(x, …)` 的正文里不含 `<br>`。
 */
export function isSingleLine(text: string): boolean {
	return bodyLines(text).length === 1;
}

/**
 * Popup：把选中的 Markdown 文本转成可放大的 HTML 块。
 *
 * 每个换行 = 一个 `<br>`（原文的空行 = 相邻两个 `<br>`），整段正文压在**一行**里：
 * 既保证块里没有空行，也让弹窗的富文本渲染不多出换行（见文件头的格式说明）。
 * 选区末尾的空行会被丢掉：编辑器选到行尾时常常多带一个换行，留着只会让 `</T>` 前多出一行。
 *
 * `tag` 由命令层决定（按 `isSingleLine` 取单行 / 多行标签）；本函数的签名与行为不随设置变化。
 */
export function markdownToHtml(text: string, tag: string): string {
	const body = bodyLines(text).map((line) => convertInline(line)).join('<br>');
	return `<${tag}>\n${body}\n</${tag}>`;
}

/** 反向规则表：认得的行内标签 → Markdown 写法。`literal` = 内容不再递归转换（只还原实体）。 */
interface BackwardRule {
	marker: string;
	literal?: boolean;
	void?: boolean;
}

/**
 * 别的标签一律**原样保留**：不认识的标签不猜、不删（非破坏性原则）。
 * 刻意不引入 DOM / `sanitizeHTMLToDom`：那会净化属性，把用户写的 `<span style="…">` 改掉。
 */
const BACKWARD_RULES: Readonly<Record<string, BackwardRule>> = {
	strong: { marker: '**' },
	b: { marker: '**' },
	em: { marker: '*' },
	i: { marker: '*' },
	mark: { marker: '==' },
	del: { marker: '~~' },
	s: { marker: '~~' },
	strike: { marker: '~~' },
	code: { marker: '`', literal: true },
	br: { marker: '\n', void: true },
};

/**
 * Unpopup：把块内内容还原成 Obsidian 支持的 Markdown。
 *
 * 单趟扫描 + 递归：只动认得的标签，其余字节原样透传（畸形 HTML 不修复、不猜）。
 */
function convertInlineBack(text: string): string {
	let out = '';
	let index = 0;

	while (index < text.length) {
		const at = text.indexOf('<', index);
		if (at < 0) {
			out += decodeEntities(text.slice(index));
			break;
		}

		out += decodeEntities(text.slice(index, at));

		const tag = readTag(text, at);
		const rule = tag ? BACKWARD_RULES[tag.name] : undefined;
		if (!tag || !rule || tag.closing) {
			// 裸 `<`、未知标签、孤立的闭标签：都原样保留
			out += tag ? tag.raw : '<';
			index = at + (tag ? tag.raw.length : 1);
			continue;
		}

		if (rule.void) {
			out += rule.marker;
			index = at + tag.raw.length;
			continue;
		}

		const close = readClosingTag(text, tag.name, at + tag.raw.length);
		if (!close) {
			// 找不到配对闭标签：不猜，原样保留
			out += tag.raw;
			index = at + tag.raw.length;
			continue;
		}

		const inner = text.slice(at + tag.raw.length, close.start);
		out += rule.marker + (rule.literal ? decodeEntities(inner) : convertInlineBack(inner)) + rule.marker;
		index = close.end;
	}

	return out;
}

/** 找 `</name>`；找不到返回 null。 */
function readClosingTag(text: string, name: string, from: number): { start: number; end: number } | null {
	const match = new RegExp(`</${name}\\s*>`, 'gi').exec(text.slice(from));
	if (!match) return null;
	const start = from + match.index;
	return { start, end: start + match[0].length };
}

/**
 * Unpopup：块内内容 → Markdown。
 *
 * 先折掉「`<br>` + 紧随的源码换行」：手写块常把 `<br>` 写在行尾，那里既是换行也是软换行，
 * 不折会在还原时多出一个空行（本插件生成的单行正文不受影响）。
 * 再按约定去掉「标签独占一行」的那两个换行，最后做行内还原。
 */
export function htmlToMarkdown(inner: string): string {
	const folded = normalizeNewlines(inner).replace(/<br\s*\/?>\n/gi, '\n');
	return convertInlineBack(folded.replace(/^\n/, '').replace(/\n$/, ''));
}

/** 区间里定位到的最外层元素。 */
export interface PopupElement {
	/** 外层标签名（小写）。 */
	tag: string;
	/** 标签内的原文。 */
	inner: string;
	/** 相对区间原文的偏移：`[start, end)` 覆盖 `<T>…</T>` 整段。 */
	start: number;
	end: number;
}

/** 区间开头的块级开标签（前导空格 ≤3，与 `blocks.ts` 的块起始判据一致）。 */
const OPENING_TAG = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?>/;

/**
 * 在区间原文里定位最外层元素，供 Unpopup 只替换 `<T>…</T>` 这一段。
 *
 * 闭标签取区间里**最后**一个 `</tag>`：HTML 块到第一个空行才结束（`blocks.ts`），
 * `</div>` 后面紧邻的非空行会被一起扫进区间，取最后一个才能把那些用户后文留在块外、不误删。
 * 只认「区间开头就是开标签、且标签在支持列表里」的形态；找不到闭标签则返回 null（畸形 HTML 不猜）。
 */
export function findOuterPopupElement(raw: string, tags: readonly string[]): PopupElement | null {
	const opening = OPENING_TAG.exec(raw);
	const tag = opening?.[1]?.toLowerCase();
	if (!opening || !tag || !tags.includes(tag)) return null;

	const closing = new RegExp(`</${tag}\\s*>`, 'gi');
	let last: RegExpExecArray | null = null;
	let match = closing.exec(raw);
	while (match) {
		last = match;
		match = closing.exec(raw);
	}

	const start = opening.index;
	if (!last || last.index <= start + opening[0].length) return null;

	return {
		tag,
		inner: raw.slice(start + opening[0].length, last.index),
		start,
		end: last.index + last[0].length,
	};
}
