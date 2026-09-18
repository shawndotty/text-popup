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
 * 列表是唯一一个「留原文就彻底失效」的块级语法（`- a<br>- b` 在编辑器与弹窗里都不会成列表），
 * 所以它被特判成真正的 HTML 列表，压在正文那一行里：
 *
 *   <div>
 *   文字<br><ul><li>一项</li><li>二项</li></ul><br>文字
 *   </div>
 *
 * **三条**来自既有实现的硬约束：
 * - **块里不能有空行**：块级原始 HTML 到第一个空行就结束（`blocks.ts` 的 `matchHtmlBlock`），
 *   一旦生成空行，块会被截断、后半段掉出弹窗。正文写成**独占一行的单行**，结构上不可能有空行。
 * - **正文里的行结构不能用 `<p>`**：`<p><p>a</p><p>b</p></p>` 会被 HTML 解析器拆开，
 *   `findSupportedElement`（`tags.ts`）命中的是第一个空 `<p>`，`hasContent` 为假 → 块直接不算候选。
 *   用 `<br>` 表达换行，则 `div` / `p` / `section` 等任意块级标签都是合法嵌套。
 * - **正文里的块级元素只能是 `ul` / `ol`**（以及它们的 `li`），且只画在正文那一行里，不引入换行。
 *   推论：**含列表的正文不能拿 `p` 当外壳** —— 解析器在「in body」插入模式下遇到 `<ul>` 会自动闭合
 *   未闭合的 `<p>`，末尾那个孤立 `</p>` 还会再补出一个**空 `<p>`**，`findSupportedElement` 命中的
 *   就是这个空元素 → `hasContent` 为假 → 块没有放大图标。命令层因此把「选区正文含列表」判成多行形态
 *   （`hasBlockBody`），并给 `resolvePopupTag` 加了一条 `p` 守卫兜底。
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
 * 正文里是否会出现块级元素（列表）。
 *
 * 命令层用它把单行选区的判据从「没有 `<br>`」收紧成「没有 `<br>` 也没有块级元素」：
 * 正文里出现 `<ul>` / `<ol>` 时外壳不能用 `<p>`（见文件头第三条契约）。
 * 与 `isSingleLine` 共用 `bodyLines`，判定与生成不会漂移。
 */
export function hasBlockBody(text: string): boolean {
	return bodyLines(text).some((line) => splitListLine(line) !== null);
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

/**
 * 正文行 → HTML：连续的列表行归成一段渲染成列表元素，其余行照旧逐行走行内转换。
 * 行与行、段与段之间一律用 `<br>` 连接 —— 列表元素因此压在正文那一行里，块里不会出现空行。
 */
function renderBody(lines: readonly string[]): string {
	const parts: string[] = [];
	let index = 0;

	while (index < lines.length) {
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
