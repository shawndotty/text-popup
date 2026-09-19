/**
 * 正向正文编排 + 行判定 + Popup 入口。
 *
 * 生成格式（本文件所有细节都服务于它）：
 *
 *   <div>
 *   第一段第一行<br>第一段第二行<br><br>第二段
 *   </div>
 *
 * 列表、**表格**与**标题**是三个「留原文就失效」的块级语法，都被特判成真正的 HTML 元素，
 * 压在正文那一行里。每个换行 = 一个 `<br>`，整段正文压在**一行**里：既保证块里没有空行，
 * 也让弹窗的富文本渲染不多出换行。
 */

import { convertInline } from './forward-inline';
import { matchHeading, renderHeading } from './forward-heading';
import { buildListBlocks, renderListBlocks, splitListLine } from './forward-list';
import type { ListLine } from './forward-list';
import { matchTable, renderTableHtml } from './forward-table';
import { normalizeNewlines } from './shared';

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
 * `tag` 由命令层决定（按 `isSingleLine` 与 `hasBlockBody` 取单行 / 多行标签）；本函数的签名与行为不随设置变化。
 */
export function markdownToHtml(text: string, tag: string): string {
	const body = renderBody(bodyLines(text));
	return `<${tag}>\n${body}\n</${tag}>`;
}
