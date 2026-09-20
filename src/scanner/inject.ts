/**
 * scanner 模块的图标注入与移除：在四类区块的控制栏里插入放大图标。
 *
 * 四处锚点里，前两处是「往核心建好的容器 / chip 里插节点」，第三处是图片嵌入，
 * 第四处（引用块）不走 DOM —— 唯一由 CM6 装饰器托管的一处，见 `scanner/quote.ts`。
 */

import { setIcon } from 'obsidian';
import { t } from '../lang/helpers';
import { TextPopupModal } from '../modal';
import { findSupportedElement } from '../tags';
import { createTextPopupSource } from './session';
import {
	ACTION_CLASS,
	ACTIONS_SELECTOR,
	FLAIR_ACTION_CLASS,
	type TextPopupHost,
} from './shared';

/** 摘掉某个区块上的按钮（标签列表改小、或该类别被关掉时使用）。 */
export function removeAction(blockEl: HTMLElement): void {
	blockEl.querySelector<HTMLElement>(`:scope > .embed-actions > .${ACTION_CLASS}`)?.remove();
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
 * 建按钮并接好交互 —— 四处锚点共用（引用块那一处是唯一不注入 DOM 的，见 `scanner/quote.ts`）。
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
