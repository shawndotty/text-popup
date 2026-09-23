/**
 * Canvas 只读快照：把 `.canvas` 的 JSON 画成一份绝对定位的 DOM。
 *
 * 为什么要有这个文件：核心给 `![[x.canvas]]` 画的是 **minimap**（`svg.canvas-minimap`，
 * 只有轮廓、没有文字、没有内嵌内容、没有交互），放进弹窗等于「放大一张缩略图」。
 * 本插件改成自研快照 —— 用**公开 API**（`MarkdownRenderer` + 自建 DOM/CSS）把画布 JSON
 * 画成只读内容，节点里的 Markdown / 嵌入都按笔记里的样子出。
 *
 * 与核心画布的关系（取舍见 Plan-20260923-093506 §1）：
 * - **不追求像素级一致**：字体层级、`--zoom-multiplier` 那一套、组的背景图、边的曲率细节都不做；
 * - **没有任何写回路径**：这里只画 DOM，不碰 `.canvas` 文件，也不给节点挂拖拽 / 编辑能力。
 *
 * 分两层：
 * - 纯函数层（`parseCanvasDocument` / `canvasBounds` / `edgeEndpoints` / `edgePath`）只吃数据、
 *   可在 `node --test` 里断言，是本仓库既有的做法（见 `headingColorVariables` / `canvasBounds` 这类先例）；
 * - DOM 层（`renderCanvasSnapshot`）才碰 `MarkdownRenderer` 与 Obsidian 的 DOM 增强方法。
 *
 * 坐标系：**画布坐标 1:1 当 px 用**，只在 DOM 层转一次（减 `bounds.x/y`）。整体缩放交给
 * `--tp-canvas-fit`（由 modal.ts 的 `fitScaledContent` 按内容区可用盒算出来），
 * 所以放大仍然复用弹窗既有的两条手势（Ctrl/Cmd+滚轮、Alt+点击），这个文件一行都不碰。
 */

import { MarkdownRenderer } from 'obsidian';
import type { App, Component } from 'obsidian';

/** 画布节点的四类（其余类型一律丢弃：不认识的节点画不出来，留着只会出现空盒子）。 */
export type CanvasNodeType = 'text' | 'file' | 'link' | 'group';

/** 节点 / 边的四个锚点方位。 */
export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasNode {
	id: string;
	type: CanvasNodeType;
	x: number;
	y: number;
	width: number;
	height: number;
	/** `'1'..'6'`（核心色板）或 `#rrggbb`；缺省时落回 body 上的默认灰。 */
	color?: string;
	/** `text` 节点的 Markdown 源码。 */
	text?: string;
	/** `file` 节点的链接目标（笔记 / 图片 / 画布…）。 */
	file?: string;
	/** `file` 节点的「缩小」子路径：`#标题` / `#^块id` / `#page=N` / `#视图名`。没有 = 显示整篇。 */
	subpath?: string;
	/** `link` 节点的外链地址。 */
	url?: string;
	/** `group` 节点的标题。 */
	label?: string;
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide: Side;
	toNode: string;
	toSide: Side;
	color?: string;
	/** `'none'` 时不画箭头。 */
	toEnd?: string;
}

export interface CanvasDocument {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Line {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/** 快照四周的留白（画布坐标）。语义 = 「四周留多少呼吸位」。 */
export const CANVAS_PADDING = 40;

const NODE_TYPES: readonly CanvasNodeType[] = ['text', 'file', 'link', 'group'];
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** 节点 id → 节点；`edgePath` 与组 / 节点的绘制共用。 */
type NodeIndex = Map<string, CanvasNode>;

// ——————————————————————————————————————————————————————————————
// 纯函数层
// ——————————————————————————————————————————————————————————————

/** 可选字段：只在真的是非空字符串时收进模型（`null` / 数字都不收）。 */
function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNode(value: unknown): CanvasNode | null {
	if (typeof value !== 'object' || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || raw.id === '') return null;
	if (!NODE_TYPES.includes(raw.type as CanvasNodeType)) return null;

	const box = [raw.x, raw.y, raw.width, raw.height];
	if (box.some((size) => typeof size !== 'number' || !Number.isFinite(size))) return null;

	const node: CanvasNode = {
		id: raw.id,
		type: raw.type as CanvasNodeType,
		x: raw.x as number,
		y: raw.y as number,
		width: raw.width as number,
		height: raw.height as number,
	};
	for (const key of ['color', 'text', 'file', 'url', 'label', 'subpath'] as const) {
		const field = readOptionalString(raw, key);
		if (field !== undefined) node[key] = field;
	}
	return node;
}

function readEdge(value: unknown): CanvasEdge | null {
	if (typeof value !== 'object' || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || raw.id === '') return null;
	if (typeof raw.fromNode !== 'string' || typeof raw.toNode !== 'string') return null;
	// 方位不合法就没法画：锚点算式只有四个分支，猜一个会让连线指向莫名其妙的地方
	if (!SIDES.includes(raw.fromSide as Side) || !SIDES.includes(raw.toSide as Side)) return null;

	const edge: CanvasEdge = {
		id: raw.id,
		fromNode: raw.fromNode,
		fromSide: raw.fromSide as Side,
		toNode: raw.toNode,
		toSide: raw.toSide as Side,
	};
	for (const key of ['color', 'toEnd'] as const) {
		const field = readOptionalString(raw, key);
		if (field !== undefined) edge[key] = field;
	}
	return edge;
}

/**
 * 画布 JSON 文本 → 模型。任何异常都返回 null（调用方因此回退成纯文本，而不是弹一屏空白）：
 * 非 JSON / 不是对象 / `nodes` 不是数组 / 节点全被过滤掉（空画布不该弹窗）。
 *
 * `edges` 缺失或不是数组时当 `[]` —— 边画不出来不影响节点，没必要因此丢掉整份快照。
 */
export function parseCanvasDocument(text: string): CanvasDocument | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const data = raw as { nodes?: unknown; edges?: unknown };
	if (!Array.isArray(data.nodes)) return null;

	const nodes = data.nodes
		.map((node) => readNode(node))
		.filter((node): node is CanvasNode => node !== null);
	if (nodes.length === 0) return null;

	const edges = Array.isArray(data.edges)
		? data.edges.map((edge) => readEdge(edge)).filter((edge): edge is CanvasEdge => edge !== null)
		: [];
	return { nodes, edges };
}

/**
 * 节点包围盒 + 四周留白；空数组返回 null。
 *
 * 只按节点算，**不把边算进去**：边两端都锚在节点边界上，必然落在盒内。
 */
export function canvasBounds(nodes: readonly CanvasNode[], padding: number): Rect | null {
	if (nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + node.width);
		maxY = Math.max(maxY, node.y + node.height);
	}
	return {
		x: minX - padding,
		y: minY - padding,
		width: maxX - minX + padding * 2,
		height: maxY - minY + padding * 2,
	};
}

/** 某个 side 的中点（退化盒 —— 宽高 0 —— 也只是返回同一个点，不抛）。 */
function sidePoint(node: CanvasNode, side: Side): { x: number; y: number } {
	const midX = node.x + node.width / 2;
	const midY = node.y + node.height / 2;
	switch (side) {
		case 'top':
			return { x: midX, y: node.y };
		case 'bottom':
			return { x: midX, y: node.y + node.height };
		case 'left':
			return { x: node.x, y: midY };
		default:
			return { x: node.x + node.width, y: midY };
	}
}

/** 某条边两个端点的坐标（取该 side 的中点）。 */
export function edgeEndpoints(
	from: CanvasNode,
	fromSide: Side,
	to: CanvasNode,
	toSide: Side,
): Line {
	const start = sidePoint(from, fromSide);
	const end = sidePoint(to, toSide);
	return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** 控制点外推距离的上下限（画布坐标）。下限保证「贴着的两个盒子」也有一段圆角，上限防止远距边甩出去。 */
const EDGE_CONTROL_MIN = 20;
const EDGE_CONTROL_MAX = 120;

/** 箭头三角形的斜边长（画布坐标）。 */
const ARROW_SIZE = 10;

/** 端点沿该 side 的外法线外推 `distance`，作为贝塞尔的控制点。 */
function controlPoint(point: { x: number; y: number }, side: Side, distance: number): {
	x: number;
	y: number;
} {
	switch (side) {
		case 'top':
			return { x: point.x, y: point.y - distance };
		case 'bottom':
			return { x: point.x, y: point.y + distance };
		case 'left':
			return { x: point.x - distance, y: point.y };
		default:
			return { x: point.x + distance, y: point.y };
	}
}

/** 一条边的完整几何：两端点 + 两个控制点（`edgePath` 与 `edgeArrowPath` 共用同一份算式）。 */
function edgeGeometry(
	from: CanvasNode,
	fromSide: Side,
	to: CanvasNode,
	toSide: Side,
): { line: Line; start: { x: number; y: number }; end: { x: number; y: number } } {
	const line = edgeEndpoints(from, fromSide, to, toSide);
	// 控制点沿 side 法线外推 clamp(两盒间距 × 0.25, 20, 120)：间距越远、弧度越舒展，
	// 但夹在下限 / 上限之间 —— 贴着走的边不会退化成直线，远距边也不会甩到大半个画布外。
	const span = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
	const distance = Math.min(EDGE_CONTROL_MAX, Math.max(EDGE_CONTROL_MIN, span * 0.25));
	return {
		line,
		start: controlPoint({ x: line.x1, y: line.y1 }, fromSide, distance),
		end: controlPoint({ x: line.x2, y: line.y2 }, toSide, distance),
	};
}

/**
 * 端点 → SVG path 的 `d`（三次贝塞尔）。
 *
 * `from` / `to` 缺失（边的另一头指向一个被过滤掉的节点）时返回 null，由调用方丢弃这条边。
 */
export function edgePath(
	from: CanvasNode | undefined,
	fromSide: Side,
	to: CanvasNode | undefined,
	toSide: Side,
): string | null {
	if (!from || !to) return null;
	const { line, start, end } = edgeGeometry(from, fromSide, to, toSide);
	return `M ${line.x1} ${line.y1} C ${start.x} ${start.y} ${end.x} ${end.y} ${line.x2} ${line.y2}`;
}

/**
 * 箭头三角形（tip 落在终点，方向取「末端控制点 → 终点」= 贝塞尔在终点处的切线）。
 *
 * 为什么不用 SVG 的 `<marker>`：marker 在 `<defs>` 里、**不在 path 的继承链上**，
 * 想让箭头跟着每条边的 `--canvas-color` 走就得靠 `context-stroke`（Chromium 独有特性）
 * 或者为每种颜色各建一个 marker。自己算这个三角形既没有特性依赖，颜色也天然随 path 走。
 * 方向为 0（两点重合）时返回 null，由调用方跳过箭头。
 */
export function edgeArrowPath(
	from: CanvasNode | undefined,
	fromSide: Side,
	to: CanvasNode | undefined,
	toSide: Side,
): string | null {
	if (!from || !to) return null;
	const { line, end } = edgeGeometry(from, fromSide, to, toSide);
	const dx = line.x2 - end.x;
	const dy = line.y2 - end.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return null;
	const ux = dx / length;
	const uy = dy / length;
	const baseX = line.x2 - ux * ARROW_SIZE;
	const baseY = line.y2 - uy * ARROW_SIZE;
	// 底边半宽取斜边的一半左右，视觉上接近核心画布的箭头
	const half = ARROW_SIZE * 0.45;
	const px = -uy * half;
	const py = ux * half;
	return `M ${line.x2} ${line.y2} L ${baseX + px} ${baseY + py} L ${baseX - px} ${baseY - py} Z`;
}

/**
 * file 节点的嵌入文本：`![[文件]]`，卡片被「缩小至标题 / 块」时带 `#子路径`。
 *
 * 为什么拼接就够、不用自己切内容：核心画布卡片干的就是这件事 ——
 * `{ linktext: filePath + subpath }` 交给同一套 embed 管线（`W1.load`），与本插件
 * `MarkdownRenderer.render` 的入口相同；切标题 / 切块由核心的 PD / ID 完成（见 [[Plan-20260923-105138]] §2.3）。
 *
 * 非法 subpath（不以 `#` 开头，只可能来自手改的 `.canvas`）**忽略**：盲拼会拼出一个解析不到的
 * 链接、卡片里变成一串未解析文字；忽略则退回整篇（弹窗是可读优先的只读浏览器）。
 */
export function canvasEmbedText(node: CanvasNode): string {
	const subpath = node.subpath?.startsWith('#') ? node.subpath : '';
	return `![[${node.file ?? ''}${subpath}]]`;
}

// ——————————————————————————————————————————————————————————————
// DOM 层
// ——————————————————————————————————————————————————————————————

export interface CanvasRenderHost {
	app: App;
	/**
	 * 解析基准：**画布文件自己的 path**（节点里的 `[[链接]]` 相对画布文件解析，不是相对笔记）。
	 */
	sourcePath: string;
	/** `MarkdownRenderer` 要求传入真实 Component，随弹窗关闭自动卸载。 */
	component: Component;
}

/**
 * 连线的 SVG 图层：`viewBox` 直接用画布坐标，所以 `edgePath` 的 d 不必再减一遍（少一处漂移）。
 */
function createEdgesEl(canvasEl: HTMLElement, bounds: Rect): SVGElement {
	return canvasEl.createSvg('svg', {
		cls: 'text-popup-canvas-edges',
		attr: { viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}` },
	});
}

/**
 * 节点 / 边的配色：`'1'..'6'` 复用核心的 `.mod-canvas-color-N`（它只写 `--canvas-color`），
 * `#rrggbb` 直接写变量；**没有颜色就什么都不写** —— 落回 `body` 上核心声明的默认灰，
 * 与笔记里的画布一致。一个颜色常量都不在本插件里硬编码。
 */
function applyCanvasColor(el: HTMLElement | SVGElement, color: string | undefined): void {
	if (!color) return;
	if (/^[1-6]$/.test(color)) el.addClass(`mod-canvas-color-${color}`);
	else el.style.setProperty('--canvas-color', color);
}

/** 节点盒的四个坐标：一律写画布坐标（减掉包围盒原点），坐标系只在这里转一次。 */
function placeBox(el: HTMLElement, node: CanvasNode, bounds: Rect): void {
	el.style.left = `${node.x - bounds.x}px`;
	el.style.top = `${node.y - bounds.y}px`;
	el.style.width = `${node.width}px`;
	el.style.height = `${node.height}px`;
}

/**
 * 组的背景色块（先插，压在节点下面）。
 *
 * 背景单独一层而不是给组盒写 `opacity`：`opacity` 会连 label 一起淡化（12% 不透明度下
 * 标签基本读不出来），而 label 是要给人看的。分成两层之后背景可以随便透明、文字保持全不透明。
 */
function createGroupEl(canvasEl: HTMLElement, node: CanvasNode, bounds: Rect): void {
	const groupEl = canvasEl.createDiv({ cls: 'text-popup-canvas-group' });
	applyCanvasColor(groupEl, node.color);
	placeBox(groupEl, node, bounds);
	groupEl.createDiv({ cls: 'text-popup-canvas-group-bg' });
	if (node.label) {
		groupEl.createDiv({ cls: 'text-popup-canvas-group-label', text: node.label });
	}
}

/** 一个节点的内容：文字节点与文件节点交给 `MarkdownRenderer`，外链节点自建 `<a>`。 */
async function renderNodeContent(
	contentEl: HTMLElement,
	node: CanvasNode,
	host: CanvasRenderHost,
): Promise<void> {
	switch (node.type) {
		case 'text':
			await MarkdownRenderer.render(host.app, node.text ?? '', contentEl, host.sourcePath, host.component);
			return;
		case 'file':
			// 与笔记里的写法一致：笔记 / 图片 / 嵌套嵌入都由核心按 `![[…]]` 渲染；
			// 卡片在画布里被「缩小至标题 / 块」时，`subpath` 一并带上 → 弹窗里也只出那一节。
			await MarkdownRenderer.render(host.app, canvasEmbedText(node), contentEl, host.sourcePath, host.component);
			return;
		case 'link': {
			const url = node.url ?? '';
			const linkEl = contentEl.createEl('a', {
				cls: 'external-link',
				text: url,
				href: url,
			});
			linkEl.setAttribute('target', '_blank');
			linkEl.setAttribute('rel', 'noopener');
			return;
		}
		default:
			return;
	}
}

/**
 * 把模型画成 `el` 里的一棵 DOM 树。
 *
 * 结构（类名一律以 `text-popup-canvas-` 开头 —— **不复用**核心的 `.canvas-node*` 结构类：
 * 那些类会连核心画布的交互样式一起带进来，而本插件要的是一份纯只读快照）：
 *
 * ```
 * div.text-popup-canvas-fit            ← 尺寸 = 缩放后的盒（供 .text-popup-text 居中 / 滚动）
 *   div.text-popup-canvas              ← 尺寸 = 画布包围盒，transform: scale(fit)
 *     svg.text-popup-canvas-edges      ← position: absolute; inset: 0
 *       path.text-popup-canvas-edge ×M   ← 每条边一条连线
 *       path.text-popup-canvas-arrow ×M  ← 箭头（`toEnd === 'none'` 时不画）
 *     div.text-popup-canvas-group ×N     ← 组（先插，压在节点下面）
 *       div.text-popup-canvas-group-bg     ← 背景层（自己带 opacity，不淡化 label）
 *       div.text-popup-canvas-group-label  ← 组标题
 *     div.text-popup-canvas-node  ×N
 *       div.text-popup-canvas-node-content.markdown-rendered
 * ```
 *
 * 位置一律写 `style.left/top/width/height`（画布坐标 px），坐标系只在这里转一次（减 `bounds.x/y`）；
 * `svg` 的 `viewBox` 直接用画布坐标，所以 `edgePath` 的 d 不必再减一遍 —— 少一处漂移。
 * `pointer-events: none` 只给 `svg`（连线不该抢点击），节点里的文字 / 链接保持可选可点。
 *
 * 画不出来（节点全被过滤掉 / 包围盒算不出来）时**正常返回、容器留空** —— 由 `renderBody`
 * 的「有文本 或 有子元素」判据回退成纯文本（= 画布文件名），永远不会出现一屏空白。
 */
export async function renderCanvasSnapshot(
	el: HTMLElement,
	doc: CanvasDocument,
	host: CanvasRenderHost,
): Promise<void> {
	const bounds = canvasBounds(doc.nodes, CANVAS_PADDING);
	if (!bounds) return;

	const fitEl = el.createDiv({ cls: 'text-popup-canvas-fit' });
	fitEl.style.setProperty('--tp-canvas-w', `${bounds.width}px`);
	fitEl.style.setProperty('--tp-canvas-h', `${bounds.height}px`);
	const canvasEl = fitEl.createDiv({ cls: 'text-popup-canvas' });

	const index: NodeIndex = new Map(doc.nodes.map((node) => [node.id, node]));

	const edgesEl = createEdgesEl(canvasEl, bounds);
	for (const edge of doc.edges) {
		const from = index.get(edge.fromNode);
		const to = index.get(edge.toNode);
		const d = edgePath(from, edge.fromSide, to, edge.toSide);
		if (!d) continue;
		const path = edgesEl.createSvg('path', { cls: 'text-popup-canvas-edge', attr: { d } });
		applyCanvasColor(path, edge.color);
		// `toEnd === 'none'` 是无箭头（核心的另一种取值只有 'arrow'，缺省也是箭头）
		if (edge.toEnd === 'none') continue;
		const arrow = edgeArrowPath(from, edge.fromSide, to, edge.toSide);
		if (!arrow) continue;
		const arrowEl = edgesEl.createSvg('path', {
			cls: 'text-popup-canvas-arrow',
			attr: { d: arrow },
		});
		applyCanvasColor(arrowEl, edge.color);
	}

	for (const node of doc.nodes) {
		if (node.type === 'group') createGroupEl(canvasEl, node, bounds);
	}

	for (const node of doc.nodes) {
		if (node.type === 'group') continue;
		const nodeEl = canvasEl.createDiv({ cls: 'text-popup-canvas-node' });
		applyCanvasColor(nodeEl, node.color);
		placeBox(nodeEl, node, bounds);
		const contentEl = nodeEl.createDiv({
			cls: 'text-popup-canvas-node-content markdown-rendered',
		});
		await renderNodeContent(contentEl, node, host);
	}
}
