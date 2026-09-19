/**
 * 正向列表：Markdown 列表行 → `<ul>` / `<ol>` HTML 元素。
 *
 * 判据按 CommonMark 收紧，**宁可漏判也不误判**。
 */

import { convertInline } from './forward-inline';

/** 一行原文切片成的列表项；不是列表行时 `splitListLine` 返回 null。 */
export interface ListLine {
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
 * 上一行是普通文本、下一行是 `- a` **算列表**（CommonMark 允许段落紧接列表，与编辑器观感一致）。
 */
export function splitListLine(line: string): ListLine | null {
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
export function renderListBlocks(blocks: readonly ListBlock[]): string {
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

export { buildListBlocks };
