/**
 * 弹窗过滤模式的纯函数层（V123，方案 [[Plan-20260925-072735]] §5）。
 *
 * 为什么单独一个文件：过滤要能被**单测钉住**，而弹窗层的判据（键盘、DOM、几何）在本仓库
 * 没有可跑的 DOM 环境（与 `modal.ts` 的 `wheelZoomTarget` / `settleZoomFrame` 同一条理由）。
 * 所以这里一行 DOM / App 都不碰：只吃 `TextBlockRegion` 与字符串，产出类型、命中下标、文案。
 *
 * 三条口径来自 [[Discuss-20260925-072827]] 的默认答复（Q5~Q8）：
 * - `excalidraw` 单独一路，但**不动 `BlockKind`**（它还被设置项与注入开关用着），
 *   只在 `PopupEntryType` 这一层合成；
 * - 图片类（image / canvas / excalidraw）的搜索文本取**嵌入语法原文**，不查 frontmatter、
 *   不读 Canvas JSON（那两样都要异步，而搜索文本必须在开弹窗那一刻同步算完）；
 * - 匹配是「大小写不敏感子串 + 空格分词 AND」，不做正则 / 拼音 / 排除词（二期再说）。
 */

import type { BlockKind, TextBlockRegion } from './blocks';
import { isExcalidrawEmbed, readTextBody } from './extract';

/**
 * 一条候选在过滤里呈现的类型。
 *
 * `BlockKind` 之外的 `excalidraw`：**只在过滤这一层合成** —— 它在扫描器里是
 * `kind: 'image'` + 「同名 PNG/SVG 图片回退」（`scanner/session.ts` 的 `createCandidate`），
 * 而卡片要求它能被 `@excalidraw` 单独筛出来。改 `BlockKind` 会牵动设置项与注入开关，
 * 成本远大于收益。
 */
export type PopupEntryType = BlockKind | 'excalidraw';

/**
 * 补全列表与类型筛选的固定顺序。
 *
 * 前六个是卡片点名的次序，后两个（`math` / `html`）补在末尾 —— 固定顺序比「按出现顺序」
 * 好预测：同一篇笔记每次 `@` 出来的列表位置都一样，肌肉记忆才有用。
 */
export const TYPE_ORDER: readonly PopupEntryType[] = [
	'image',
	'table',
	'callout',
	'canvas',
	'excalidraw',
	'quote',
	'code',
	'math',
	'html',
];

/** 一条候选的过滤元信息：类型 + 可搜索文本。长度恒等于 `source.size`。 */
export interface PopupEntry {
	type: PopupEntryType;
	text: string;
}

/** 区间 → 过滤类型。Excalidraw 靠「真的解析成 Excalidraw 嵌入」判，与其回退分支同源。 */
export function entryTypeOf(region: TextBlockRegion): PopupEntryType {
	if (region.kind === 'image' && isExcalidrawEmbed(region.raw)) return 'excalidraw';
	return region.kind;
}

/** 开围栏行的 info string（` ```python ` → `python`）；不是围栏时返回空串。 */
const FENCE_INFO = /^ {0,3}(?:`{3,}|~{3,})(.*)$/;

/**
 * 区间 → 搜索文本。分类取值（理由见方案 §5.1）：
 *
 * - `code`：正文 **+ 开围栏行的 info string** —— 带上语言名后，搜 `python` 能一次捞出所有
 *   Python 块（正文里通常一个 `python` 都没有，光搜正文那条最有用的查询反而打不中）。
 * - `image` / `canvas` / `excalidraw`：**嵌入语法原文** —— 天然覆盖 wiki target 的文件名、
 *   `![[x.png|图注]]` 的别名、`![alt](url)` 的 alt。不用 `extractImageBody`：它在 wiki 形态下
 *   只返回别名 / target 二者之一，是给「关富文本时显示什么」用的，不是给搜索用的。
 * - 其余五类：`readTextBody`，与「关闭富文本渲染时看到的那份纯文本」同源，口径已经量过。
 */
export function entrySearchText(region: TextBlockRegion, type: PopupEntryType): string {
	if (type === 'image' || type === 'canvas' || type === 'excalidraw') return region.raw;
	// `readTextBody` 只覆盖「七类非 HTML 区块」（html 由 session 走离屏渲染，不经过它），
	// 所以手写 HTML 的搜索文本在这里单独取原文 —— 否则 `@html` 能筛出来、却一个字也搜不到。
	if (type === 'html') return region.raw;
	if (type !== 'code') return readTextBody(region);
	const info = FENCE_INFO.exec(region.raw.split('\n')[0] ?? '')?.[1]?.trim() ?? '';
	return info ? `${readTextBody(region)}\n${info}` : readTextBody(region);
}

/** 一次解析的结果：`field` 与 `query` 都没定 = 未定态（按全量处理、不标红）。 */
export interface PopupFilter {
	field: PopupEntryType | null;
	query: string;
}

/** 未定态：既不按类型筛，也不按文本筛。 */
const UNDETERMINED: PopupFilter = { field: null, query: '' };

/**
 * 令牌 → 类型（规则 a~d，见方案 §5.2）。
 *
 * a. 精确相等；b. 令牌**以某类型名开头**（`@tablexy` → `table`，中文「不打空格」靠它）；
 * c. 唯一缩写（`@tab` → `table`）；d. 都不满足 → 未定态。
 * b 命中多个时取**最长**的那个（`@codex` 在 `[code, codeblock]` 里取 `codeblock`）。
 */
function resolveTypeToken(token: string, pool: readonly PopupEntryType[]): PopupEntryType | null {
	if (pool.includes(token as PopupEntryType)) return token as PopupEntryType;
	const prefixed = pool.filter((type) => token.startsWith(type));
	if (prefixed.length > 0) {
		return prefixed.reduce((longest, type) => (type.length > longest.length ? type : longest));
	}
	const abbreviated = pool.filter((type) => type.startsWith(token));
	return abbreviated.length === 1 ? (abbreviated[0] ?? null) : null;
}

/**
 * 输入框原文 → 过滤条件。
 *
 * - 不以 `@` 开头（含 `a@b` 这种出现在中间的）→ 全文搜索，整串都是 query；
 * - `@` 之后第一个空白之前是类型令牌，其后是 query（`@table x y` = 在表格里搜 x 与 y）；
 * - 令牌定不下来（空 / 歧义 / 不认识）→ 未定态。刻意如此：敲到 `@` 或 `@c` 时红盒闪一下
 *   是纯噪音，真正「输完了却没命中」才标红。
 */
export function parseFilterInput(input: string, pool: readonly PopupEntryType[]): PopupFilter {
	const trimmed = input.trim();
	if (!trimmed) return UNDETERMINED;
	if (!trimmed.startsWith('@')) return { field: null, query: trimmed };

	const rest = trimmed.slice(1);
	const space = /\s/.exec(rest);
	const token = space ? rest.slice(0, space.index) : rest;
	// 空令牌（刚敲下 `@`）一律未定态：哪怕 pool 里只有一个类型，也别替用户选定
	if (!token) return UNDETERMINED;
	const field = resolveTypeToken(token, pool);
	if (!field) return UNDETERMINED;
	// 有空格 → 空格之后的整段是 query；没空格 → 令牌里被类型名消费掉之后剩下的就是 query
	// （`@tablexy` → 在表格里搜 `xy`，中文「不打空格」的场景同理）
	const query = (space ? rest.slice(space.index) : token.slice(field.length)).trim();
	return { field, query };
}

/**
 * 命中项在**全集**里的下标；空数组 = 没有过滤（调用方按全量处理）。
 *
 * 返回全集下标而不是过滤后的子数组：`show()` / `step()` / `updateTitle()` 都活在「全集」的
 * 坐标系里（弹窗的 index 就是全集下标），命中集只用来**约束**它。
 */
export function matchEntries(entries: readonly PopupEntry[], filter: PopupFilter): number[] {
	const tokens = filter.query
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.toLowerCase());
	const matches: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (filter.field !== null && entry.type !== filter.field) continue;
		if (tokens.length === 0) {
			matches.push(i);
			continue;
		}
		const text = entry.text.toLowerCase();
		if (tokens.every((token) => text.includes(token))) matches.push(i);
	}
	return matches;
}

/**
 * 可见范围的**两端**在全集里的下标 —— `[`（第一个）/ `]`（最后一个）的落点。
 *
 * 范围口径与 `step` / ↑↓ / 计数完全同源：有命中（`matches.length > 0`）就走命中集，
 * 否则退化成全集。返回 `null` = 范围是空的（没有候选），调用方什么都不该做 ——
 * `show()` 拿不到落点会静默不动，把这个判据留在纯函数里才钉得住。
 *
 * 与 `modal.ts` 的 `visibleAt(pos)` 是同一件事的两个入口：那个吃任意 pos（给 step / ↑↓ 用），
 * 这个只吃两端（给 `[` / `]` 用）。单独留一条的理由是「两端」正是本次要能用单测钉住的语义。
 */
export function edgeIndex(
	matches: readonly number[],
	size: number,
	edge: 'first' | 'last',
): number | null {
	const filtered = matches.length > 0;
	const total = filtered ? matches.length : size;
	if (total <= 0) return null;
	const pos = edge === 'first' ? 0 : total - 1;
	return filtered ? (matches[pos] ?? null) : pos;
}

/**
 * 本篇实际出现的类型（去重，按 `TYPE_ORDER` 排序）。
 *
 * 「只列本篇出现的」是卡片的要求（A9）：一篇只有表格与图片的笔记，补全列表不该出现 `math`。
 */
export function availableTypes(entries: readonly PopupEntry[]): PopupEntryType[] {
	const present = new Set(entries.map((entry) => entry.type));
	return TYPE_ORDER.filter((type) => present.has(type));
}

/** 补全候选：空令牌给全部，否则按前缀过滤（类型令牌是英文小写，忽略大小写不亏）。 */
export function suggestTypes(token: string, pool: readonly PopupEntryType[]): PopupEntryType[] {
	const prefix = token.toLowerCase();
	return prefix ? pool.filter((type) => type.startsWith(prefix)) : [...pool];
}

/** 补全弹层此刻该不该显示，以及要拿去过滤列表的令牌。 */
export interface SuggestionContext {
	showing: boolean;
	token: string;
}

/**
 * 只在「`@` 打头、且光标还在第一个令牌内部」时显示补全。
 *
 * 一旦敲了空格进入 query 段就立刻收起 —— 否则每敲一个字弹层都要跟着刷新一次，
 * 而那时用户要搜的是内容，不是类型。
 */
export function suggestionContext(input: string, caret: number): SuggestionContext {
	const hidden: SuggestionContext = { showing: false, token: '' };
	if (!input.startsWith('@') || caret < 1) return hidden;
	const boundary = /\s/.exec(input)?.index ?? input.length;
	if (caret > boundary) return hidden;
	return { showing: true, token: input.slice(1, caret) };
}

/**
 * 补全弹层的水平落点：与 `@` 左边缘对齐，再夹进过滤框内（右侧至少留 `margin`）。
 *
 * 与 `@` 对齐是用户点名要的（V123 反馈二）：原来写在 CSS 里的 `left: 50%` + `translateX(-50%)`
 * 是相对整条过滤框居中的，输入框铺满一行时看着就落在**屏幕中间**，离 `@` 十万八千里。
 *
 * 夹取不是防御性代码：条件长到光标顶到输入框右端时，对齐落点会让整块弹层跑出过滤框被弹窗裁掉，
 * 夹回「右边距 = margin」才一直在框内（`boxWidth > barWidth - margin` 时落到 0，宁可左边贴边）。
 *
 * 纯函数、只吃数字：真机几何（`getBoundingClientRect`、字体度量、`scrollLeft`）只能在
 * `modal.ts` 里量 —— 与文件头「弹窗层判据在本仓库没有可跑的 DOM 环境」同源。
 */
export function suggestAnchorLeft(
	anchor: number,
	boxWidth: number,
	barWidth: number,
	margin: number,
): number {
	return Math.max(0, Math.min(anchor, barWidth - boxWidth - margin));
}

/**
 * 标题栏文案。三种形态（方案 §5.5）：
 * - 有命中：`名称 · 2 / 5 · 已筛选 (12)`；
 * - 无过滤 / 无命中：`名称 · 7 / 12`；
 * - 只有一条：只给名字（与今天「只有一条不加序号」的既有行为一致）。
 *
 * `filteredLabel` 由调用方传进来（= `t('Filtered')`）：纯函数不认识 i18n，与
 * `headingColorVariables(style)` 那种「只收成一个参数」的处理同理。
 */
export function formatPopupTitle(
	name: string,
	pos: number,
	shown: number,
	total: number,
	filtered: boolean,
	filteredLabel: string,
): string {
	if (filtered) return `${name} · ${pos} / ${shown} · ${filteredLabel} (${total})`;
	return total > 1 ? `${name} · ${pos} / ${total}` : name;
}
