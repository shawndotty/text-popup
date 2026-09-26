/**
 * 反向转换：HTML → Markdown（Unpopup 的核心）。
 *
 * 单趟扫描 + 递归：只动认得的标签，其余字节原样透传（畸形 HTML 不修复、不猜）。
 * 别的标签一律**原样保留**：不认识的标签不猜、不删（非破坏性原则）。
 * `<a href="…">` 因带属性装不进「标记包裹」规则表，与列表 / 表格 / 标题一样特判（见 `readLinkElement`）。
 * 刻意不引入 DOM / `sanitizeHTMLToDom`：那会净化属性，把用户写的 `<span style="…">` 改掉。
 *
 * 本文件整体保留为一个模块：`convertInlineBack` 递归调用 `readListElement` / `readTableElement` /
 * `readHeadingElement`，而 `readHeadingElement` 又回调 `convertInlineBack`。拆成多文件会形成循环 import，
 * 且所有函数均为 `function` 声明（运行时才互调），保留在同一文件内最清晰。
 */

import { escapePipes } from './forward-table';
import { decodeEntities, normalizeNewlines, readTag, TableAlign } from './shared';

/** 反向规则表：认得的行内标签 → Markdown 写法。`literal` = 内容不再递归转换（只还原实体）。 */
interface BackwardRule {
	marker: string;
	literal?: boolean;
	void?: boolean;
}

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

/** 从标签原文里读 `href` 值（容忍 `"…"` / `'…'` / 裸值三种写法），解码实体；没有则返回 null。 */
function readHref(raw: string): string | null {
	const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tagAttributes(raw));
	if (!match) return null;
	return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * 解析一个带 `href` 的 `<a>` → `[文字](URL)`；没有 `href` 或找不到配对的 `</a>` 时返回 null，
 * 由调用方按「未知标签」原样保留（不猜、不降级）。
 *
 * 只保留 `href`，`class` / `target` / `rel` 一并丢弃 —— 与其它行内标签「属性被丢弃」一致；
 * 本插件自己产出的 `<a>` 只有 href，往返因此无损。文字走同一套行内还原（`<a><strong>x</strong></a>` → `[**x**](u)`）。
 */
function readLinkElement(text: string, at: number): { markdown: string; end: number } | null {
	const head = readTag(text, at);
	if (!head || head.closing || head.name !== 'a') return null;

	const href = readHref(head.raw);
	if (href === null) return null;

	const close = readClosingTag(text, 'a', at + head.raw.length);
	if (!close) return null;

	const inner = convertInlineBack(text.slice(at + head.raw.length, close.start));
	return { markdown: `[${inner}](${href})`, end: close.end };
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

/** 找 `</name>`；找不到返回 null。 */
function readClosingTag(text: string, name: string, from: number): { start: number; end: number } | null {
	const match = new RegExp(`</${name}\\s*>`, 'gi').exec(text.slice(from));
	if (!match) return null;
	const start = from + match.index;
	return { start, end: start + match[0].length };
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

		if (tag && !tag.closing && tag.name === 'a') {
			const link = readLinkElement(text, at);
			if (link) {
				out += link.markdown;
				index = link.end;
				continue;
			}
			// 没有 href / 缺配对闭标签：落到下面的「未知标签」处理，原样保留
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
