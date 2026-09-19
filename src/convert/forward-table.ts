/**
 * 正向表格：Markdown 表格 → HTML `<table>`。
 *
 * 表格与列表同属「留原文就彻底失效」的块级语法（`| a |` 与 `| - |` 被 `<br>` 压成一行后，
 * 编辑器不解析块内 Markdown、弹窗也认不出分隔行 → 两边都不成表格），因此同样转成真正的 HTML。
 * 判据逐条对齐核心的 `table` 规则，刻意不做更强的猜测。
 */

import { convertInline } from './forward-inline';
import { splitListLine } from './forward-list';
import { matchHeading } from './forward-heading';
import { hasCodeIndent, TableAlign } from './shared';

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

/**
 * 把内容里**未被转义**的 `|` 补上反斜杠。
 *
 * 还原出的表格会被自己的竖线切断，所以单元格里的字面竖线必须重新转义；
 * 只看紧邻的那串反斜杠的奇偶，已经是 `\|` 的不会再补一层。
 */
export function escapePipes(text: string): string {
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
export function matchTable(lines: readonly string[], start: number): TableBlock | null {
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
export function renderTableHtml(table: TableBlock): string {
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

export type { TableBlock };
