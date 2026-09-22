/**
 * scanner 模块的图标注入与移除：在各类区块的控制栏里插入放大图标。
 *
 * 六处锚点里，前三处是「往核心建好的容器 / chip 里插节点」（`.cm-embed-block` 内的
 * `.embed-actions`、代码块 chip、图片的 `.embed-actions`），第四处是表格（容器由本插件
 * 自己在 `.table-wrapper` 里建），第五处（引用块）不走 DOM —— 唯一由 CM6 装饰器托管的一处，
 * 见 `scanner/quote.ts`；第六处是 Canvas / 被 Excalidraw 接管的图片嵌入，同样是「容器在、
 * 图标容器不在」，容器由本插件自建（见 `injectEmbedAction`）。
 */

import { setIcon } from 'obsidian';
import { isExcalidrawEmbed, resolveExcalidrawImage } from '../extract';
import { t } from '../lang/helpers';
import { TextPopupModal } from '../modal';
import { findSupportedElement } from '../tags';
import { createTextPopupSource } from './session';
import {
	ACTION_CLASS,
	ACTIONS_SELECTOR,
	containingMarkdownView,
	EMBED_ACTIONS_CLASS,
	FLAIR_ACTION_CLASS,
	TABLE_ACTIONS_CLASS,
	type TextPopupHost,
} from './shared';

/** 摘掉某个区块上的按钮（标签列表改小、或该类别被关掉时使用）。 */
export function removeAction(blockEl: HTMLElement): void {
	blockEl.querySelector<HTMLElement>(`:scope > .embed-actions > .${ACTION_CLASS}`)?.remove();
}

/**
 * 摘掉表格上的按钮 —— 连**自建的容器**一起删。
 *
 * 不能复用 `removeAction`：它的判据（`:scope > .embed-actions > .text-popup-action`）对表格
 * 不成立（容器在 `.table-wrapper` 里），会出现「关掉开关图标还在」。整容器一起删还顺手解决
 * 了「只删按钮会留下一个空的 `.embed-actions` 壳」。
 */
export function removeTableAction(tableEl: HTMLElement): void {
	tableEl
		.querySelector<HTMLElement>(`:scope > .table-wrapper > .${TABLE_ACTIONS_CLASS}`)
		?.remove();
}

/** 摘掉代码块 chip 里的按钮。 */
export function removeFlairAction(flairEl: HTMLElement): void {
	flairEl.querySelector<HTMLElement>(`:scope > .${FLAIR_ACTION_CLASS}`)?.remove();
}

/** 往 `.embed-actions` 里注入放大图标（widget 类区块：HTML 块 / Callout / 数学块 / 被接管的代码块）。 */
export function injectAction(blockEl: HTMLElement, host: TextPopupHost, kind: import('../blocks').BlockKind): void {
	const actionsEl = blockEl.querySelector<HTMLElement>(ACTIONS_SELECTOR);
	if (!actionsEl) return;

	// 幂等判据：按钮是否已存在。核心重渲染后 DOM 被重建，这里会自动补回。
	const existingEl = actionsEl.querySelector<HTMLElement>(`:scope > .${ACTION_CLASS}`);

	// 只有手写 HTML 块需要「按标签名」逐块判定；另外三类的闸门就是上面的类别开关。
	if (kind === 'html' && !findSupportedElement(blockEl, host.settings.supportedTags)) {
		// 标签列表被改小之后，清理不再符合条件的按钮。
		existingEl?.remove();
		return;
	}
	if (existingEl) return;

	// 插到首位 → 位于「编辑这个模块」图标左侧（RTL 由核心样式自动镜像）。
	actionsEl.insertBefore(
		createActionEl(actionsEl, host, 'embed-action'),
		actionsEl.firstChild,
	);
}

/**
 * 往图片嵌入的 `.embed-actions` 里注入放大图标，插在首位 = 原生「放大」（lucide-zoom-in）图标的左侧。
 *
 * 与 `injectAction` 的差别只有锚点与三条守卫：
 * - 没有 `.embed-actions` 的图片（Callout 内 / 行内 HTML 里的 `span.image-embed`）天然跳过 ——
 *   这类图片在扫描器里也不产候选，两边一致；
 * - 嵌入笔记（`![[某笔记]]`）里的图片不注入：候选集来自**外层笔记的文本**，在那里点开也定位不到。
 * - 引用行（`> ![x](p.png)`）里的图片不注入：整行由外层引用块覆盖（候选集里没有它），
 *   挂了就是「点开翻出别的块」的死图标 —— 与「Callout 内的图片不单独成条」同一条口径。
 */
export function injectImageAction(imageEl: HTMLElement, host: TextPopupHost): void {
	const actionsEl = imageEl.querySelector<HTMLElement>(ACTIONS_SELECTOR);
	if (!actionsEl) return;
	if (imageEl.closest('.markdown-embed')) return;
	if (imageEl.closest('.cm-line.HyperMD-quote')) return;
	if (actionsEl.querySelector<HTMLElement>(`:scope > .${ACTION_CLASS}`)) return;
	actionsEl.insertBefore(createActionEl(actionsEl, host, 'embed-action'), actionsEl.firstChild);
}

/**
 * 往 Markdown 表格的右上角注入放大图标。
 *
 * 表格是「容器在、图标容器不在」的一处：`.cm-table-widget` 本身带 `.cm-embed-block`
 * （所以既有遍历扫得到），但核心不给表格调 `addEditButton()`，它没有现成的 `.embed-actions`。
 * 所以这里自己建一个 —— 容器 class 写成 `text-popup-table-actions embed-actions`：前者用来
 * **认领**（摘的时候要连容器一起摘），后者用来白拿核心的皮肤（绝对定位 / 右上角 4px / flex /
 * gap / 默认 `opacity: 0`）与 `.embed-action` 的胶囊样式，不需要新增任何外观 CSS
 * （只有「悬停显形」那一条要补，见 styles.css —— 核心的显隐规则显式 `:not(.cm-table-widget)`）。
 *
 * 锚点是 `.table-wrapper`（表格本体）而不是 widget 容器：后者常被拉满行宽（实测 732px vs
 * 表格 347px），锚在它上面按钮会飘到编辑区右缘、离表格很远；且它是 `overflow-x: auto` 的
 * 滚动区，宽表格时按钮会随内容横向滚动。
 *
 * 形态变了（找不到 `.table-wrapper`）就**不注入**，绝不退化成别的锚点 —— 挂了按钮却没候选
 * （或反过来）就是本仓库最忌讳的幽灵条目。
 */
export function injectTableAction(tableEl: HTMLElement, host: TextPopupHost): void {
	const wrapper = tableEl.querySelector<HTMLElement>(':scope > .table-wrapper');
	if (!wrapper) return;

	let actionsEl = wrapper.querySelector<HTMLElement>(`:scope > .${TABLE_ACTIONS_CLASS}`);
	if (!actionsEl) actionsEl = wrapper.createDiv(`${TABLE_ACTIONS_CLASS} embed-actions`);
	// 幂等判据：按钮已存在就跳过（`render()` 重建后容器没了，这里会自动补回）
	if (actionsEl.querySelector<HTMLElement>(`:scope > .${ACTION_CLASS}`)) return;

	const actionEl = createActionEl(actionsEl, host, 'embed-action');
	guardMouseDown(actionEl);
	// 插首位：与另外几处一致，保证重复注入 / 重建后的位置稳定
	actionsEl.insertBefore(actionEl, actionsEl.firstChild);
}

/**
 * 表格按钮独有的 `mousedown` 守卫（**不**加进 `createActionEl`）。
 *
 * 真机 A/B（`dev:cdp` 派真实鼠标点击）实测：表格是本插件唯一会被「顺手挪光标」的锚点 ——
 * 只拦 `click` 时点击按钮会把光标在同一行内挪 2 个字符（表格 widget 内部有真实可编辑的单元格，
 * `posAtCoords` 能把点击点映射回文档）；同一个按钮再拦 `mousedown` 后光标不动。另外四处锚点
 * 实测都不需要（例如既有 HTML 块的按钮只拦 `click` 就不挪光标），所以只在这里补。
 *
 * 代价：鼠标按下不再给按钮聚焦（键盘 `Tab` 停留 + `Enter` 仍可用）。
 */
function guardMouseDown(actionEl: HTMLElement): void {
	actionEl.addEventListener('mousedown', (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
	});
}

/** 第六处注入点认得的两类嵌入（见 `qualifyEmbed`）。 */
export type EmbedKind = 'canvas' | 'excalidraw';

/**
 * 这个嵌入是不是「本插件要自建容器」的那两类；返回 null = 不是，跳过。
 *
 * 两条判据都来自真机实测（Obsidian 1.13.7 + Excalidraw 2.27.3）：
 * - `canvas-embed`：核心 CanvasEmbed 建的（`app.js` 的 `a.addClass("canvas-embed")`）；
 * - `image-embed` + `src` 指向 Excalidraw 绘图：Excalidraw 插件 `processInternalEmbed()` 改写的标记。
 *   **不能按「没有 .embed-actions」判** —— 那会把「核心还没建容器的普通图片」也卷进来，
 *   而核心对 N1（ImageEmbed）是**无条件** `addAction()` 的，按它判等于用偶发状态当判据。
 */
export function qualifyEmbed(embedEl: HTMLElement): EmbedKind | null {
	if (embedEl.classList.contains('canvas-embed')) return 'canvas';
	const src = embedEl.getAttribute('src') ?? '';
	if (!src) return null;
	return isExcalidrawEmbed(`![[${src}]]`) ? 'excalidraw' : null;
}

/**
 * 现在该不该有图标 —— **必须与「候选集里有没有它」同源**，否则就是幽灵图标。
 *
 * 前三条守卫与 `injectImageAction` 同源，理由也一样（候选集里没有它，挂了就是点不开的死图标）：
 * 1. 在别的可放大区块里：`.cm-embed-block` 有祖先 ⇒ 那一块已经有自己的图标了，多挂一个是重复图标。
 *    实测：`> [!note]` 里的 canvas **确实**建出了 `.canvas-embed`，它的 `.closest('.cm-embed-block')`
 *    正是那个 `.cm-callout`；而外层 Callout 在候选集里吃掉了整段（`matchCallout` 优先）。
 * 2. 在嵌入笔记（`![[某笔记]]`）里：候选集来自外层笔记文本，点了定位不到。
 * 3. 在引用行（`> …`）里：整行由外层引用块覆盖。
 *
 * 第四条只对 Excalidraw 生效：候选集里那条在「关闭同名图片回退」或「找不到同名 SVG/PNG」时会被
 * createCandidate 丢掉（session.ts 的 `createCandidate`），图标必须同步消失。
 */
export function canMagnifyEmbed(embedEl: HTMLElement, host: TextPopupHost, kind: EmbedKind): boolean {
	if (embedEl.closest('.markdown-embed')) return false;
	if (embedEl.closest('.cm-line.HyperMD-quote')) return false;
	if (embedEl.closest('.cm-embed-block')) return false;
	if (kind !== 'excalidraw') return true;

	const src = embedEl.getAttribute('src') ?? '';
	if (!host.settings.excalidrawImageFallback) return false;
	return (
		resolveExcalidrawImage(
			host.app,
			`![[${src}]]`,
			containingMarkdownView(host.app, embedEl)?.file?.path ?? '',
			host.settings.excalidrawPreferredFormat,
		) !== null
	);
}

/**
 * 往「核心没建 .embed-actions」的嵌入容器里注入放大图标（Canvas / 被接管的 Excalidraw）。
 *
 * 容器 class 写成 `text-popup-embed-actions embed-actions`：前者用来**认领**（摘的时候要连容器
 * 一起摘），后者用来白拿核心的皮肤与定位 —— 与表格那一处同法（见 `injectTableAction`）。
 * 差别只在 CSS：Excalidraw 的容器 `.image-embed` 自带 `position: relative`、也在核心的悬停规则
 * 里，一条 CSS 都不用补；Canvas 那两条要自己补（见 styles.css）。
 */
export function injectEmbedAction(embedEl: HTMLElement, host: TextPopupHost, kind: EmbedKind): void {
	if (!canMagnifyEmbed(embedEl, host, kind)) {
		// 闸门关掉后要把已注入的按钮摘掉（关「放大图片」/ 关 Excalidraw 回退时立刻生效）
		removeEmbedAction(embedEl);
		return;
	}
	let actionsEl = embedEl.querySelector<HTMLElement>(`:scope > .${EMBED_ACTIONS_CLASS}`);
	if (!actionsEl) actionsEl = embedEl.createDiv(`${EMBED_ACTIONS_CLASS} embed-actions`);
	// 幂等判据：按钮已存在就跳过（重渲染后容器没了，这里会自动补回）
	if (actionsEl.querySelector<HTMLElement>(`:scope > .${ACTION_CLASS}`)) return;
	// 插首位：与另外几处一致，保证重复注入 / 重建后的位置稳定
	actionsEl.insertBefore(createActionEl(actionsEl, host, 'embed-action'), actionsEl.firstChild);
}

/**
 * 摘掉自建的容器 —— 连容器一起删，不能复用 `removeAction`。
 *
 * 理由与 `removeTableAction` 逐字相同：`removeAction` 的判据
 * （`:scope > .embed-actions > .text-popup-action`）会只删掉按钮、留下一个空 `.embed-actions` 壳。
 */
export function removeEmbedAction(embedEl: HTMLElement): void {
	embedEl.querySelector<HTMLElement>(`:scope > .${EMBED_ACTIONS_CLASS}`)?.remove();
}

/**
 * 往普通代码块右上角的 chip（`.code-block-flair`）里注入放大图标。
 *
 * 与 `.embed-actions` 版本的区别只有锚点：chip 里没有图标槽位，所以按钮是 chip 的**子节点**
 * （`inline` → span，样式见 styles.css 的 `.text-popup-flair-action`）。嵌在 widget 内部这一点
 * 是刻意的：CM6 会忽略 widget 内部的 DOM 变更，按钮不会被「看不懂的 DOM 变更」反复冲掉。
 */
export function injectFlairAction(flairEl: HTMLElement, host: TextPopupHost): void {
	// 引用块 / Callout 源码里的围栏行首带 `>`，扫描器不当候选（见 blocks.ts），因此不挂按钮：
	// 哪怕哪天这类行真挂上了 chip，也不会出现「点开却翻出别的块」。实测当前版本核心不给它们建 chip。
	if (flairEl.closest('.cm-line')?.classList.contains('HyperMD-quote')) return;
	if (flairEl.querySelector<HTMLElement>(`:scope > .${FLAIR_ACTION_CLASS}`)) return;
	flairEl.insertBefore(createActionEl(flairEl, host, FLAIR_ACTION_CLASS, true), flairEl.firstChild);
}

/**
 * 建按钮并接好交互 —— 五处锚点共用（引用块那一处是唯一不注入 DOM 的，见 `scanner/quote.ts`；
 * 表格那处额外补一条 `mousedown` 守卫，见 `guardMouseDown`）。
 *
 * `inline` 用 span：代码块 chip 是行内的 `display: inline-block`，div 会在里面另起一行。
 * interactive-child 是核心约定的「交互子元素」标记：核心的点击接管与双击进块都会跳过它。
 * 图标用 maximize-2 而不是 zoom-in，避免与弹窗控制条上的「整体放大」图标混淆。
 */
export function createActionEl(
	parent: HTMLElement,
	host: TextPopupHost,
	classes: string,
	inline = false,
): HTMLElement {
	const cls = `${classes} interactive-child ${ACTION_CLASS}`;
	const actionEl = inline ? parent.createSpan({ cls }) : parent.createDiv({ cls });
	actionEl.setAttribute('role', 'button');
	actionEl.setAttribute('tabindex', '0');
	// 惰性取文案：写成模块级 `const ACTION_LABEL = t('Magnify')` 会把语言冻结在加载时刻，
	// 改语言后已注入的按钮不会跟着变。
	actionEl.setAttribute('aria-label', t('Magnify'));
	setIcon(actionEl, 'maximize-2');

	const open = (evt?: Event): void => {
		// 核心在 widget 容器上挂了「点击即进入块内编辑」的延迟处理：它先看 defaultPrevented，
		// 所以这里拦下就能避免「光标跳进块里 + 编辑器滚动 + 本块图标被销毁」。
		// 代码块 chip 自己就是「点击复制代码」按钮，同样靠这里拦住复制。
		evt?.preventDefault();
		evt?.stopPropagation();
		const { source, startIndex } = createTextPopupSource(host, actionEl);
		// 空块不弹窗：与 1.0.2 的 `if (!plain && !rich) return;` 等价
		if (!source.read(startIndex)) {
			source.dispose?.();
			return;
		}
		new TextPopupModal(host.app, source, startIndex, host.settings).open();
	};

	actionEl.addEventListener('click', open);
	actionEl.addEventListener('keydown', (evt) => {
		if (evt.key !== 'Enter' && evt.key !== ' ') return;
		evt.preventDefault();
		open();
	});

	return actionEl;
}
