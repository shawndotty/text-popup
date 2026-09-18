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
 * 列表、**表格**与**标题**是三个「留原文就失效」的块级语法 —— 只不过失效方式不同：列表与表格是
 * 「两边都不成列表 / 不成表格」（`- a<br>- b`、`| a |<br>| - |`），标题则是**把同一行的后续内容吃进标题**
 * （`## T<br>正文` 里的 `##` 范围到本行结束，`<br>` 只是行内元素、不结束标题）。所以它们都被特判成
 * 真正的 HTML 元素，压在正文那一行里：
 *
 *   <div>
 *   文字<br><ul><li>一项</li><li>二项</li></ul><br>文字
 *   </div>
 *
 *   <div>
 *   文字<br><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
 *   </div>
 *
 *   <div>
 *   <h2>标题</h2><br>正文
 *   </div>
 *
 * 标题元素**不带任何属性**：ATX 语法表达不了它们，带属性会让反向还原无从下手（见 §反向的标题分支）。
 *
 * **三条**来自既有实现的硬约束：
 * - **块里不能有空行**：块级原始 HTML 到第一个空行就结束（`blocks.ts` 的 `matchHtmlBlock`），
 *   一旦生成空行，块会被截断、后半段掉出弹窗。正文写成**独占一行的单行**，结构上不可能有空行。
 * - **正文里的行结构不能用 `<p>`**：`<p><p>a</p><p>b</p></p>` 会被 HTML 解析器拆开，
 *   `findSupportedElement`（`tags.ts`）命中的是第一个空 `<p>`，`hasContent` 为假 → 块直接不算候选。
 *   用 `<br>` 表达换行，则 `div` / `p` / `section` 等任意块级标签都是合法嵌套。
 * - **正文里的块级元素只能是 `h1`–`h6` / `ul` / `ol` / `table`**（以及它们的 `li` / `tr` / `th` / `td`），
 *   且只画在正文那一行里，不引入换行。
 *   推论：**含块级元素的正文不能拿 `p` 当外壳** —— 解析器在「in body」插入模式下遇到 `<ul>`（`<hN>` 同理）
 *   会自动闭合未闭合的 `<p>`，末尾那个孤立 `</p>` 还会再补出一个**空 `<p>`**，`findSupportedElement`
 *   命中的就是这个空元素 → `hasContent` 为假 → 块没有放大图标。命令层因此把「选区正文含列表 / 标题」
 *   判成多行形态（`hasBlockBody`），并给 `resolvePopupTag` 加了一条 `p` 守卫兜底。
 *   （`<table>` 不受这条约束：解析器不拿它闭合 `<p>`，实测 `<p><table>` 在弹窗里照常出表格。
 *   表格天然 ≥2 行（表头 + 分隔行）→ 永远走多行标签，`hasBlockBody` 对它没有意义。）
 *
 * 表格的判据逐条对齐核心（markdown-it 的 `table` 规则），**宁可漏判也不误判**：
 * - **必须起一个块**：表头行前面得是空行、选区开头、或**一个 ATX 标题行**（`text` 紧邻表头只是一段
 *   带竖线的普通文字；标题不会「懒惰续行」吃表头行，实测核心在标题的下一行无空行也认表格）；
 * - 表头行与**分隔行**都必须含**未转义的** `|`（否则 `a` + `---` 是 Setext 标题；`| a |` + `---`
 *   同样是 Setext 标题，实测核心在阅读视图里给出 `h2` 而不是表格 —— 只有 `| a |` + `| - |` 才是单列表格）；
 * - 列数取**分隔行**的格数，表头行与数据行一律按它截断 / 补空；
 * - 数据行遇到空行、缩进 ≥4、不含未转义 `|`、列表行、引用行、ATX 标题即终止（表格后面不需要空行）；
 * - 分流顺序 `heading` → `table` → `list` → 普通行，与核心的 block 规则顺序一致
 *   （`# x | y` + `| - | - |` 是标题、`- a | b` + `--- | ---` 是表格 —— 只有这个顺序能同时满足两条）。
 *
 * 标题的判据同样逐条对齐核心的 ATX 规则，宁可漏判也不误判：缩进 0–3、`#` 后必须是空白或行尾、
 * 1–6 个 `#`、尾部闭合串（空白 + 纯 `#`）去掉、行内照常走 `convertInline`。刻意不做 Setext 标题
 * （`S\n===`）：往返必然变形，且 `===` / `---` 与分隔线、表格分隔行共享字符，判据面成倍扩大。
 *

 * 注意区分上面第二条与**外层标签**：外层标签用 `p`（单行选区的默认值）是合法的 ——
 * 它的正文要么是单行纯文本（不含任何 `<br>` 与块级元素），要么用 `<br>` 表达换行，
 * 都不涉及「正文里拿 `<p>` 当行结构」。
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

/** 一行原文切片成的列表项；不是列表行时 `splitListLine` 返回 null。 */
interface ListLine {
	/** 无序 / 有序。`*` `+` 与 `-` 同属无序（反向统一还原成 `-`）。 */
	kind: 'ul' | 'ol';
	/** 有序列表的编号（无序为 0，只用于整层的 `start`）。 */
	number: number;
	/** 任务项的勾选状态；非任务项为 null。 */
	task: boolean | null;
	/** 项内容（已剥掉列表标记、任务标记与标记后的空白）。 */
	content: string;
	/** 前导缩进列数（空格 1 列、Tab 按 1 列，不做 Tab 展开）。 */
	indent: number;
}

/**
 * 分隔线：整行由同一个 `-` / `*` / `_` 组成 ≥3 个（允许中间空白，如 `- - -` / `* * *`）。
 * 必须先于列表判据命中 —— `- - -` 剥掉首标记后剩下的 `- -` 长得就像一个列表项。
 */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** 无序标记；标记后必须是空白或行尾（`-test` / `*斜体*` 都不是列表）。 */
const UNORDERED = /^([-*+])(?:[ \t]+(.*))?$/;

/** 有序标记：1–9 位数字 + `.` / `)`；同样要求标记后有空白或行尾（`1.test` 不是列表）。 */
const ORDERED = /^(\d{1,9})([.)])(?:[ \t]+(.*))?$/;

/** 任务标记：`[ ]` / `[x]` / `[X]`，后面必须是空白或行尾（`- [x]a` 不算任务，按普通内容走）。 */
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;

/**
 * 把一行原文切成列表项。
 *
 * 判据按 CommonMark 收紧，**宁可漏判也不误判**：标记后必须是空白或行尾，分隔线整行排除，
 * `*斜体*` / `snake_case` / `-test` / `1.test` 都留在原文里走行内转换。
 * 上一行是普通文本、下一行是 `- a` **算列表**（CommonMark 允许段落紧接列表，与编辑器观感一致）。
 */
function splitListLine(line: string): ListLine | null {
	if (THEMATIC_BREAK.test(line)) return null;

	const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
	const rest = line.slice(leading.length);

	const unordered = UNORDERED.exec(rest);
	const ordered = unordered ? null : ORDERED.exec(rest);
	if (!unordered && !ordered) return null;

	const content = (unordered ? unordered[2] : ordered?.[3]) ?? '';
	const task = TASK.exec(content);

	return {
		kind: unordered ? 'ul' : 'ol',
		number: ordered ? Number.parseInt(ordered[1] ?? '1', 10) : 0,
		task: task ? task[1] !== ' ' : null,
		content: task ? (task[2] ?? '') : content,
		indent: leading.length,
	};
}

/**
 * 正文里是否会出现块级元素（列表 / 标题）。
 *
 * 命令层用它把单行选区的判据从「没有 `<br>`」收紧成「没有 `<br>` 也没有块级元素」：
 * 正文里出现 `<ul>` / `<ol>` / `<h1>`–`<h6>` 时外壳不能用 `<p>`（见文件头第三条契约：
 * 它们都会被解析器用来闭合未闭合的 `<p>`，末了再补出一个空 `<p>` → 幽灵块）。
 * 与 `isSingleLine` 共用 `bodyLines`，判定与生成不会漂移。
 */
export function hasBlockBody(text: string): boolean {
	return bodyLines(text).some((line) => splitListLine(line) !== null || matchHeading(line) !== null);
}

/** 一个列表层：同缩进、同 kind 的一串项。 */
interface ListBlock {
	kind: 'ul' | 'ol';
	/** 该层的缩进列数；只用于建树，不参与输出。 */
	indent: number;
	/** 有序列表的起始编号（取该层首项的编号）。 */
	number: number;
	items: ListItemNode[];
	/** 该层是否含任务项 —— 只要有就整个列表带 `contains-task-list`（核心的判据）。 */
	hasTask: boolean;
}

interface ListItemNode {
	task: boolean | null;
	content: string;
	/** 该项下嵌套的列表层；同缩进换 kind 时会追加成第二个兄弟层。 */
	children: ListBlock[];
}

/**
 * 把一段连续的列表行拼成层级结构。
 *
 * 缩进栈：比当前层更深 = 子列表（挂在上一层最后那个还没闭合的项里）；更浅 = 收口若干层；
 * 同缩进换 kind = 另起一个兄弟列表。结构先建好再渲染，是为了让 `contains-task-list`
 * 能落到「整层只要有一个任务项」这条核心判据上，而不是只看首项。
 */
function buildListBlocks(items: readonly ListLine[]): ListBlock[] {
	const roots: ListBlock[] = [];
	const stack: ListBlock[] = [];

	for (const item of items) {
		while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) > item.indent) stack.pop();
		const top = stack[stack.length - 1];
		if (top && top.indent === item.indent && top.kind !== item.kind) stack.pop();

		const parent = stack[stack.length - 1];
		let block = parent && parent.indent === item.indent ? parent : null;
		if (!block) {
			block = { kind: item.kind, indent: item.indent, number: item.number, items: [], hasTask: false };
			const owner = parent?.items[parent.items.length - 1];
			if (owner) owner.children.push(block);
			else roots.push(block);
			stack.push(block);
		}

		block.items.push({ task: item.task, content: item.content, children: [] });
		if (item.task !== null) block.hasTask = true;
	}

	return roots;
}

/**
 * 列表层级结构 → HTML。markup 照抄核心（`ul.contains-task-list` / `li.task-list-item` /
 * `input.task-list-item-checkbox`）：这些类名是核心 CSS 的锚点，编辑器 HTML 块与弹窗两处都拿得到。
 *
 * 项内容一律走 `convertInline` —— 列表项不需要任何专门处理，`**粗体**` / `==高亮==` / `` `code` ``
 * 与普通行走同一条路。刻意不抄 `data-line` / `data-task`（那是实时预览回写笔记用的行号锚点，
 * 我们没有行号语义），用 `disabled` 表示「这里点不动」，与核心的非交互形态一致。
 */
function renderListBlocks(blocks: readonly ListBlock[]): string {
	let out = '';

	for (const block of blocks) {
		out +=
			block.kind === 'ul'
				? `<ul${block.hasTask ? ' class="contains-task-list"' : ''}>`
				: `<ol${block.number !== 1 ? ` start="${block.number}"` : ''}>`;

		for (const item of block.items) {
			out +=
				item.task === null
					? `<li>${convertInline(item.content)}`
					: `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"${item.task ? ' checked' : ''} disabled> ${convertInline(item.content)}`;
			out += renderListBlocks(item.children);
			out += '</li>';
		}

		out += block.kind === 'ul' ? '</ul>' : '</ol>';
	}

	return out;
}

// —— 块级转换：Markdown ATX 标题 → HTML 标题 ——
//
// 标题的失效方式与列表 / 表格不同：它**不**是「两边都不成立」，而是**把同一行的后续内容吃进标题**。
// `## Test Heading` 与后文被 `<br>` 压成一行后，`##` 的作用范围是「到本行结束」，而 `<br>` 只是行内
// 元素 —— 弹窗里于是只剩一个 `h2`，后文全变成标题文字（编辑器里则多显示一个 `##`，两头都不对）。
// 所以标题从「有意不转」名单里移出来，进入列表 / 表格那一类：转成真正的 HTML 标题，压在正文那一行里。

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
function matchHeading(line: string): HeadingLine | null {
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
function renderHeading(heading: HeadingLine): string {
	return `<h${heading.level}>${convertInline(heading.content)}</h${heading.level}>`;
}

// —— 块级转换：Markdown 表格 → HTML 表格 ——
//
// 表格与列表同属「留原文就彻底失效」的块级语法（`| a |` 与 `| - |` 被 `<br>` 压成一行后，
// 编辑器不解析块内 Markdown、弹窗也认不出分隔行 → 两边都不成表格），因此同样转成真正的 HTML。
// 判据逐条对齐核心的 `table` 规则（见文件头），刻意不做更强的猜测。

/** 表格对齐；`null` = 没指定（Markdown 的分隔行不写冒号）。 */
type TableAlign = 'left' | 'center' | 'right';

/** 从原文里认出的一张表。 */
interface TableBlock {
	/** 每列的对齐，长度 = 列数（= 分隔行的格数）。 */
	aligns: ReadonlyArray<TableAlign | null>;
	/** 表头行的单元格（已按列数截断 / 补空）。 */
	header: readonly string[];
	/** 数据行（每行都已按列数截断 / 补空）。 */
	rows: ReadonlyArray<readonly string[]>;
	/** 表格结束后的下一行下标。 */
	end: number;
}

/** 缩进 ≥4 个空格（或含制表符）就是代码块，表格 / 分隔行在那里都不成立。 */
function hasCodeIndent(line: string): boolean {
	const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
	return leading.includes('\t') || leading.length >= 4;
}

/**
 * 把内容里**未被转义**的 `|` 补上反斜杠。
 *
 * 还原出的表格会被自己的竖线切断，所以单元格里的字面竖线必须重新转义；
 * 只看紧邻的那串反斜杠的奇偶，已经是 `\|` 的不会再补一层。
 */
function escapePipes(text: string): string {
	let out = '';
	let backslashes = 0;

	for (const char of text) {
		if (char === '|' && backslashes % 2 === 0) out += '\\';
		out += char;
		backslashes = char === '\\' ? backslashes + 1 : 0;
	}

	return out;
}

/** `escapePipes` 的反向：`\|` → 字面 `|`（核心渲染表格时 `\|` 就是一个竖线字符）。 */
function unescapePipes(text: string): string {
	let out = '';
	let backslashes = 0;

	for (const char of text) {
		if (char === '|' && backslashes % 2 === 1) {
			// 丢掉转义用的那一个反斜杠；`out` 此时必定以它结尾
			out = `${out.slice(0, -1)}|`;
			backslashes = 0;
			continue;
		}
		out += char;
		backslashes = char === '\\' ? backslashes + 1 : 0;
	}

	return out;
}

/**
 * 表行 → 单元格数组；整行不含未转义的 `|` 时返回 null（那不是表行）。
 *
 * 与核心同一条规则：按**未转义的** `|` 切开，丢掉首尾由边界竖线造成的空段（`| a |` 与 `a`
 * 都是「一格」），再逐格 trim。转义过的 `\|` 不分格，且在这里就还原成字面竖线 —— 与核心的
 * 单元格内容一致（核心渲染 `\|` 时留下的是一个竖线字符，不是反斜杠加竖线）。
 *
 * 表头行与**分隔行**共用这条判据。分隔行也必须含竖线：实测核心把 `| a |` + `---` 渲染成
 * **Setext 标题**（阅读视图里是 `h2`）而不是表格，只有 `| a |` + `| - |` 才是单列表格。
 */
function splitTableRow(line: string): string[] | null {
	const cells: string[] = [];
	let current = '';
	let backslashes = 0;
	let hasPipe = false;

	for (const char of line) {
		if (char === '|' && backslashes % 2 === 0) {
			cells.push(current);
			current = '';
			hasPipe = true;
			backslashes = 0;
			continue;
		}
		current += char;
		backslashes = char === '\\' ? backslashes + 1 : 0;
	}
	cells.push(current);

	if (!hasPipe) return null;

	// 首尾两段只可能来自边界竖线，空则丢掉（中间的空格是真实的一格，不能丢）
	if (cells.length > 1 && (cells[0] ?? '').trim() === '') cells.shift();
	if (cells.length > 1 && (cells[cells.length - 1] ?? '').trim() === '') cells.pop();

	return cells.map((cell) => unescapePipes(cell.trim()));
}

/**
 * 分隔行 → 每列的对齐；不是分隔行则返回 null（这一行不成立就整张表不成立）。
 * 认 `:---`（左）/ `:---:`（中）/ `---:`（右）/ `---`（不指定），横线数量不限。
 */
function parseDelimiterRow(line: string): Array<TableAlign | null> | null {
	if (hasCodeIndent(line)) return null;
	// 核心只允许 `| - :` 与空白出现在分隔行里
	if (!/^[\s|:-]+$/.test(line)) return null;

	const cells = splitTableRow(line);
	if (!cells || cells.length === 0) return null;

	const aligns: Array<TableAlign | null> = [];
	for (const cell of cells) {
		const match = /^(:?)-+(:?)$/.exec(cell);
		if (!match) return null;
		const left = match[1] === ':';
		const right = match[2] === ':';
		aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
	}

	return aligns;
}

/** 按列数截断 / 补空 —— 列数取自分隔行，多出来的格丢掉、少掉的补空格。 */
function fitRow(cells: readonly string[], columns: number): string[] {
	const row = cells.slice(0, columns);
	while (row.length < columns) row.push('');
	return row;
}

/**
 * 从 `lines[start]` 起认一张表；不成表返回 null。
 *
 * 判据（对应文件头那几条与核心的实测）：表头行必须起一个块且含未转义的 `|`，
 * 下一行必须是合法分隔行；数据行往下吃到第一个终止行为止。
 */
function matchTable(lines: readonly string[], start: number): TableBlock | null {
	// 必须起一个块：紧跟在正文后面的表头行只是一段带竖线的普通文字。
	// 例外是 ATX 标题 —— 标题不会「懒惰续行」吃掉表头行，实测核心在标题的下一行无空行也认表格。
	if (start > 0) {
		const prev = lines[start - 1] ?? '';
		if (prev.trim() !== '' && !matchHeading(prev)) return null;
	}

	const headerLine = lines[start] ?? '';
	if (hasCodeIndent(headerLine)) return null;
	const header = splitTableRow(headerLine);
	if (!header) return null;

	const aligns = parseDelimiterRow(lines[start + 1] ?? '');
	if (!aligns) return null;

	const columns = aligns.length;
	const rows: string[][] = [];
	let index = start + 2;

	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim() === '') break;
		if (hasCodeIndent(line)) break;
		const cells = splitTableRow(line);
		if (!cells) break;
		if (splitListLine(line) || /^ {0,3}>/.test(line) || /^ {0,3}#/.test(line)) break;
		rows.push(fitRow(cells, columns));
		index += 1;
	}

	return { aligns, header: fitRow(header, columns), rows, end: index };
}

/**
 * 表格 → HTML。markup 与核心同形：表头进 `<thead>`、数据行进 `<tbody>`，对齐用 `align` 属性
 * （核心自己用的就是它，实测生效；换 `style` 反而多一层被主题 / 净化覆盖的风险）。
 * 单元格内容走 `convertInline`，与列表项同一条路：`**粗体**` / `==高亮==` / `` `代码` `` 照旧生效。
 */
function renderTableHtml(table: TableBlock): string {
	const cell = (tag: 'th' | 'td', content: string, align: TableAlign | null): string =>
		`<${tag}${align ? ` align="${align}"` : ''}>${convertInline(content)}</${tag}>`;

	let out = '<table><thead><tr>';
	for (let column = 0; column < table.header.length; column++) {
		out += cell('th', table.header[column] ?? '', table.aligns[column] ?? null);
	}
	out += '</tr></thead>';

	if (table.rows.length > 0) {
		out += '<tbody>';
		for (const row of table.rows) {
			out += '<tr>';
			for (let column = 0; column < row.length; column++) {
				out += cell('td', row[column] ?? '', table.aligns[column] ?? null);
			}
			out += '</tr>';
		}
		out += '</tbody>';
	}

	return `${out}</table>`;
}

/**
 * 正文行 → HTML：ATX 标题行渲染成 `<hN>`、连续的列表行归成一段渲染成列表元素、
 * 连续的表格行渲染成 `<table>`，其余行照旧逐行走行内转换。行与行、段与段之间一律用 `<br>` 连接 ——
 * 标题 / 列表 / 表格元素因此压在正文那一行里，块里不会出现空行。
 */
function renderBody(lines: readonly string[]): string {
	const parts: string[] = [];
	let index = 0;

	while (index < lines.length) {
		// 标题先于表格：核心把 `# x | y` + `| - | - |` 判成标题 + 段落（见文件头的判据顺序）
		const heading = matchHeading(lines[index] ?? '');
		if (heading) {
			parts.push(renderHeading(heading));
			index += 1;
			continue;
		}

		// 表格先于列表：核心的 block 规则里 table 也排在 list 之前（`- a | b` + `--- | ---` 是表格）
		const table = matchTable(lines, index);
		if (table) {
			parts.push(renderTableHtml(table));
			index = table.end;
			continue;
		}

		const line = lines[index] ?? '';
		if (!splitListLine(line)) {
			parts.push(convertInline(line));
			index += 1;
			continue;
		}

		const run: ListLine[] = [];
		while (index < lines.length) {
			const item = splitListLine(lines[index] ?? '');
			if (!item) break;
			run.push(item);
			index += 1;
		}
		parts.push(renderListBlocks(buildListBlocks(run)));
	}

	return parts.join('<br>');
}

/**
 * Popup：把选中的 Markdown 文本转成可放大的 HTML 块。
 *
 * 每个换行 = 一个 `<br>`（原文的空行 = 相邻两个 `<br>`），整段正文压在**一行**里：
 * 既保证块里没有空行，也让弹窗的富文本渲染不多出换行（见文件头的格式说明）。
 * 选区末尾的空行会被丢掉：编辑器选到行尾时常常多带一个换行，留着只会让 `</T>` 前多出一行。
 *
 * `tag` 由命令层决定（按 `isSingleLine` 与 `hasBlockBody` 取单行 / 多行标签）；本函数的签名与行为不随设置变化。
 */
export function markdownToHtml(text: string, tag: string): string {
	const body = renderBody(bodyLines(text));
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

/** 任务复选框：`<li>` 内容开头那个 `<input type="checkbox">`（属性顺序与引号都容忍）。 */
const CHECKBOX_INPUT = /^<input\b[^<>]*>/i;
const CHECKBOX_TYPE = /\btype\s*=\s*["']?checkbox["']?/i;
const CHECKBOX_CHECKED = /\bchecked\b/i;

/** 嵌套列表每深一层补的缩进（与 `splitListLine` 的 indent 同一把尺子：2 空格）。 */
const NESTED_INDENT = '  ';

/** 跳过 HTML 里没有语义的空白（项与项之间、`<li>` 与 `</ul>` 之间的换行与缩进）。 */
function skipHtmlWhitespace(text: string, from: number): number {
	let index = from;
	while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
	return index;
}

/** `<ol start="3">` 的首项编号；没有 `start` 或值不合法时返回 null（按 1 处理）。 */
function readStartNumber(raw: string): number | null {
	const value = Number.parseInt(/\bstart\s*=\s*["']?(\d+)/i.exec(raw)?.[1] ?? '', 10);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 从 `<li>` 开标签之后读到与它配对的 `</li>`。
 *
 * 配对按 `li` 深度计数（嵌套列表里还有 `<li>`），否则会在第一个内层 `</li>` 处截断。
 * 找不到配对（未闭合、被别的 `</ul>` 打断、读到文末）返回 null，由调用方按「原样保留」处理。
 */
function sliceLiContent(text: string, from: number): { raw: string; end: number } | null {
	let depth = 0;
	let pos = from;

	while (pos < text.length) {
		const at = text.indexOf('<', pos);
		if (at < 0) return null;

		const tag = readTag(text, at);
		if (!tag) {
			pos = at + 1;
			continue;
		}

		if (tag.name === 'li') {
			if (tag.closing) {
				if (depth === 0) return { raw: text.slice(from, at), end: at + tag.raw.length };
				depth -= 1;
			} else {
				depth += 1;
			}
		}
		pos = at + tag.raw.length;
	}

	return null;
}

/** 一个 `<li>` 的内容切成 Markdown：`lines[0]` 是项内容，后面是嵌套列表的 Markdown 行。 */
interface LiContent {
	task: boolean | null;
	lines: string[];
}

/**
 * `<li>` 内容 → Markdown 行。
 *
 * - 开头的 `<input type="checkbox">` 认成任务复选框，勾选态看有没有 `checked`；`<input>` 与内容
 *   之间那一个空格文本节点吃掉（核心的 markup 里固定有一个）；
 * - 嵌套的 `<ul>` / `<ol>` 递归还原成列表行，由调用方统一缩进；
 * - 嵌套列表**之后**还有非空白内容时判为畸形（Markdown 的列表项表达不了那种结构）→ 返回 null。
 */
function parseLiContent(raw: string): LiContent | null {
	let body = raw.trimStart();
	let task: boolean | null = null;

	const input = CHECKBOX_INPUT.exec(body);
	if (input && CHECKBOX_TYPE.test(input[0])) {
		task = CHECKBOX_CHECKED.test(input[0]);
		body = body.slice(input[0].length).trimStart();
	}

	let inline = '';
	const nested: string[] = [];
	let seenList = false;
	let pos = 0;

	while (pos < body.length) {
		const at = body.indexOf('<', pos);
		const chunk = at < 0 ? body.slice(pos) : body.slice(pos, at);

		if (chunk.trim() === '') {
			if (!seenList) inline += chunk;
		} else if (seenList) {
			return null;
		} else {
			inline += chunk;
		}

		if (at < 0) break;

		const tag = readTag(body, at);
		if (tag && !tag.closing && (tag.name === 'ul' || tag.name === 'ol')) {
			const list = readListElement(body, at);
			if (!list) return null;
			nested.push(list.markdown);
			seenList = true;
			pos = list.end;
			continue;
		}
		if (seenList) return null;

		inline += tag ? tag.raw : '<';
		pos = at + (tag ? tag.raw.length : 1);
	}

	return { task, lines: [inline.trimEnd(), ...nested.flatMap((markdown) => markdown.split('\n'))] };
}

/**
 * 解析一个列表元素（`<ul>` / `<ol>`）→ Markdown（`\n` 分隔的行，项与项之间不空行）。
 *
 * 畸形结构（没有 `<li>`、缺闭标签、项内嵌套不闭合、项内容表达不了）一律返回 null：
 * 调用方会把它当「未知标签」整段原样保留，不猜、不修复（非破坏性原则）。
 *
 * 三条有意的归一化（README 的反向对照表里写明）：无序标记 `*` / `+` → `-`；有序标记 `1)` → `1.`；
 * `<ol>` 只保留首项编号（`start` 之后的编号本来就无从保存）；`[X]` → `[x]`。
 */
function readListElement(text: string, at: number): { markdown: string; end: number } | null {
	const head = readTag(text, at);
	if (!head || head.closing || (head.name !== 'ul' && head.name !== 'ol')) return null;

	const ordered = head.name === 'ol';
	const start = (ordered ? readStartNumber(head.raw) : null) ?? 1;
	const lines: string[] = [];
	let count = 0;
	let pos = at + head.raw.length;

	while (true) {
		pos = skipHtmlWhitespace(text, pos);
		const tag = readTag(text, pos);

		if (tag && tag.closing && tag.name === head.name) {
			pos += tag.raw.length;
			break;
		}
		// `<li>` 之外的任何东西都算畸形：不猜、不跳过
		if (!tag || tag.closing || tag.name !== 'li') return null;

		const inner = sliceLiContent(text, pos + tag.raw.length);
		if (!inner) return null;

		const parsed = parseLiContent(inner.raw);
		if (!parsed) return null;

		const [first = '', ...rest] = parsed.lines;
		const marker = ordered ? `${start + count}. ` : '- ';
		const box = parsed.task === null ? '' : parsed.task ? '[x] ' : '[ ] ';
		// 项内容走同一条行内还原（`**粗体**` / `==高亮==` / 裸实体都在这里落回原文）
		const line = (marker + box + convertInlineBack(first)).trimEnd();
		lines.push(line, ...rest.map((nested) => NESTED_INDENT + nested));

		count += 1;
		pos = inner.end;
	}

	if (count === 0) return null;
	return { markdown: lines.join('\n'), end: pos };
}

/** HTML 表格里的一个单元格；对齐只从表头行读。 */
interface CellSpec {
	tag: 'th' | 'td';
	align: TableAlign | null;
	content: string;
}

/** 标签原文里的属性部分（去掉 `<name` 与结尾的 `>`），用于按属性名判断。 */
function tagAttributes(raw: string): string {
	return raw
		.replace(/^<\s*\/?\s*[a-zA-Z][a-zA-Z0-9-]*/, '')
		.replace(/\/?>$/, '');
}

/** 从属性串里读 `align`；没写、或 `justify` 这类 Markdown 表达不了的一律返回 null。 */
function readAlign(attributes: string): TableAlign | null {
	const value = /\balign\s*=\s*["']?(left|center|right)["']?/i.exec(attributes)?.[1]?.toLowerCase();
	return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

/**
 * 单元格上有没有 Markdown 表格表达不了的东西 —— 有就整段原样保留（不猜、不降级）。
 * `colspan` / `rowspan` 只认值 ≠1 的（`colspan="1"` 与不写等价）。
 */
function hasUnsupportedCell(attributes: string, content: string): boolean {
	if (/\bstyle\s*=/i.test(attributes)) return true;
	const span = /\b(?:col|row)span\s*=\s*["']?(\d+)/i.exec(attributes);
	if (span && span[1] !== '1') return true;
	return isUnsupportedCellContent(content);
}

/** 单元格内容里的 `<br>` 与嵌套表格都会在还原时引入换行，Markdown 表格表达不了。 */
function isUnsupportedCellContent(content: string): boolean {
	return /<br\s*\/?>/i.test(content) || /<table\b/i.test(content);
}

/** 一格内容 → Markdown 格；含换行（表达不了）时返回 null。 */
function cellToMarkdown(content: string): string | null {
	const markdown = convertInlineBack(content).trim();
	return markdown.includes('\n') ? null : escapePipes(markdown);
}

/** `| a | b |` 形态的一行。 */
function renderTableLine(cells: readonly string[]): string {
	return `| ${cells.join(' | ')} |`;
}

/** 分隔行；对齐表达不出来时就是不带冒号的 `---`（横线数量统一成 3 个）。 */
function renderDelimiterLine(aligns: ReadonlyArray<TableAlign | null>): string {
	return renderTableLine(
		aligns.map((align) => (align === 'center' ? ':---:' : align === 'left' ? ':---' : align === 'right' ? '---:' : '---')),
	);
}

/**
 * 读一个 `<tr>` 的单元格，读到与它配对的 `</tr>` 为止。
 * 结构畸形（出现 `th` / `td` 之外的元素、缺闭标签、单元格表达不了）返回 null。
 */
function readTableRow(text: string, from: number): { cells: CellSpec[]; end: number } | null {
	const cells: CellSpec[] = [];
	let pos = from;

	while (true) {
		pos = skipHtmlWhitespace(text, pos);
		const tag = readTag(text, pos);

		if (tag && tag.closing) {
			return tag.name === 'tr' && cells.length > 0 ? { cells, end: pos + tag.raw.length } : null;
		}
		if (!tag || (tag.name !== 'th' && tag.name !== 'td')) return null;

		const close = readClosingTag(text, tag.name, pos + tag.raw.length);
		if (!close) return null;

		const attributes = tagAttributes(tag.raw);
		const content = text.slice(pos + tag.raw.length, close.start);
		if (hasUnsupportedCell(attributes, content)) return null;

		cells.push({ tag: tag.name, align: readAlign(attributes), content });
		pos = close.end;
	}
}

/**
 * 解析一个 `<table>` → Markdown 表格（`\n` 分隔的行，行与行之间不空行）。
 *
 * 第一行一律当表头（Markdown 表格必须有表头，HTML 没有这个概念），对齐从表头行逐列读 `align`；
 * 每行格数必须与表头行一致（Markdown 表格必须是矩形的）。表达不了的结构一律返回 null ——
 * 调用方会把它当「未知标签」整段原样保留，不猜、不修复（非破坏性原则）。
 */
function readTableElement(text: string, at: number): { markdown: string; end: number } | null {
	const head = readTag(text, at);
	if (!head || head.closing || head.name !== 'table') return null;

	// 允许 `<thead>` / `<tbody>` / `<tfoot>` 包一层，其余元素一律算畸形
	const stack: string[] = ['table'];
	const rows: CellSpec[][] = [];
	let pos = at + head.raw.length;
	let end = -1;

	while (pos < text.length) {
		const next = text.indexOf('<', pos);
		if (next < 0) return null;
		if (text.slice(pos, next).trim() !== '') return null;

		const tag = readTag(text, next);
		if (!tag) return null;

		if (tag.closing) {
			if (stack.pop() !== tag.name) return null;
			pos = next + tag.raw.length;
			if (stack.length === 0) {
				end = pos;
				break;
			}
			continue;
		}

		if (tag.name === 'tr') {
			const row = readTableRow(text, next + tag.raw.length);
			if (!row) return null;
			rows.push(row.cells);
			pos = row.end;
			continue;
		}
		if (tag.name === 'thead' || tag.name === 'tbody' || tag.name === 'tfoot') {
			stack.push(tag.name);
			pos = next + tag.raw.length;
			continue;
		}
		return null;
	}

	const header = rows[0];
	if (end < 0 || !header) return null;
	if (rows.some((row) => row.length !== header.length)) return null;

	const lines: string[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index] ?? [];
		const cells: string[] = [];
		for (const cell of row) {
			const markdown = cellToMarkdown(cell.content);
			if (markdown === null) return null;
			cells.push(markdown);
		}
		lines.push(renderTableLine(cells));
		if (index === 0) lines.push(renderDelimiterLine(header.map((cell) => cell.align)));
	}

	return { markdown: lines.join('\n'), end };
}

/** 标题层级表：`h1`…`h6` → 1…6。不在表里的标签名一律不认。 */
const HEADING_LEVELS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/**
 * 解析一个标题元素（`<h1>`…`<h6>`）→ ATX 标题。
 *
 * 表达不了就返回 null，由调用方把**整段**原样保留（不猜、不降级、不丢信息，与畸形列表 / 表格同待遇）：
 *
 * - 开标签带任何属性（`id` / `class` / `align` / `style`…）：ATX 语法表达不了；
 * - 找不到配对的 `</hN>`；
 * - 内容还原后含换行（里面有 `<br>`、嵌套列表 / 表格）：Markdown 标题不能跨行 —— 顺带修掉
 *   `<h2>a<br>b</h2>` 过去被还原成 `<h2>a\nb</h2>` 那个半吊子产物。
 *
 * 空标题（`<h3></h3>`）只输出 `#`×N，不留尾空格。
 */
function readHeadingElement(text: string, at: number, level: number): { markdown: string; end: number } | null {
	const head = readTag(text, at);
	if (!head || head.closing || HEADING_LEVELS[head.name] !== level) return null;
	if (tagAttributes(head.raw).trim() !== '') return null;

	const close = readClosingTag(text, head.name, at + head.raw.length);
	if (!close) return null;

	const content = convertInlineBack(text.slice(at + head.raw.length, close.start)).trim();
	if (content.includes('\n')) return null;

	const marker = '#'.repeat(level);
	return { markdown: content ? `${marker} ${content}` : marker, end: close.end };
}

/**
 * 表格前面补够空行：Markdown 里表格必须**起一个块**（表头行前面得是空行或文档开头），
 * 否则 `text` + 换行 + 表头只会是一段带竖线的普通文字。
 * 列表不需要这条（CommonMark 允许列表打断段落），既有行为不动。
 */
function ensureBlockBreak(out: string): string {
	if (out === '' || out.endsWith('\n\n')) return out;
	return out.endsWith('\n') ? `${out}\n` : `${out}\n\n`;
}

/**
 * 标题前面保证有换行就够了 —— **不需要表格那种整行空行**：ATX 标题能打断段落，
 * 也能直接接在列表 / 表格后面（实测核心三种都成立）。所以 `<h2>` 前面若已有 `<br>`（→ 已是 `\n`），
 * 一个字节都不补。
 */
function ensureLineBreak(out: string): string {
	if (out === '' || out.endsWith('\n')) return out;
	return `${out}\n`;
}

/**
 * 从 `<ul>` / `<ol>` 开标签起吃掉整个元素（按同名标签深度配对）。
 *
 * 列表解析失败时用它把**整段**原样透传：逐标签往下走会让内层长得像列表的片段被单独转换，
 * 那样产物既不是原文、也不是合法列表。找不到配对闭标签时只吃掉开标签（与既有的未配对标签同待遇）。
 */
function skipElement(text: string, at: number, name: string): number {
	const opening = readTag(text, at);
	if (!opening) return at + 1;

	let depth = 1;
	let pos = at + opening.raw.length;

	while (pos < text.length) {
		const next = text.indexOf('<', pos);
		if (next < 0) break;

		const tag = readTag(text, next);
		if (!tag) {
			pos = next + 1;
			continue;
		}
		if (tag.name === name) {
			if (tag.closing) {
				depth -= 1;
				if (depth === 0) return next + tag.raw.length;
			} else {
				depth += 1;
			}
		}
		pos = next + tag.raw.length;
	}

	return at + opening.raw.length;
}

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
		if (tag && !tag.closing && (tag.name === 'ul' || tag.name === 'ol')) {
			const list = readListElement(text, at);
			if (list) {
				out += list.markdown;
				index = list.end;
				continue;
			}
			// 畸形列表：整段原样保留，不猜、不修复（非破坏性原则）
			const end = skipElement(text, at, tag.name);
			out += text.slice(at, end);
			index = end;
			continue;
		}

		if (tag && !tag.closing && tag.name === 'table') {
			const table = readTableElement(text, at);
			if (table) {
				// 表格必须「起一个块」，前面同一行还有内容时补空行（列表没有这条要求）
				out = ensureBlockBreak(out) + table.markdown;
				index = table.end;
				continue;
			}
			// 畸形表格：整段原样保留，与畸形列表同待遇
			const end = skipElement(text, at, 'table');
			out += text.slice(at, end);
			index = end;
			continue;
		}

		const headingLevel = tag && !tag.closing ? HEADING_LEVELS[tag.name] : undefined;
		if (tag && !tag.closing && headingLevel !== undefined) {
			const heading = readHeadingElement(text, at, headingLevel);
			if (heading) {
				// 标题只需要一个换行（能打断段落、也能紧跟在列表 / 表格后面），与表格那条不同
				out = ensureLineBreak(out) + heading.markdown;
				index = heading.end;
				continue;
			}
			// 表达不了的标题（带属性 / 含换行 / 缺闭标签）：整段原样保留，与畸形列表同待遇
			const end = skipElement(text, at, tag.name);
			out += text.slice(at, end);
			index = end;
			continue;
		}

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
