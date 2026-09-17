import { debounce, MarkdownView, Platform, sanitizeHTMLToDom, setIcon } from 'obsidian';
import type { App, Editor, EventRef } from 'obsidian';
import { scanTextBlocks } from './blocks';
import type { BlockKind, TextBlockRegion } from './blocks';
import {
	extractCalloutBody,
	extractFencedBody,
	extractMathBody,
	extractRichSource,
	extractText,
} from './extract';
import { TextPopupModal } from './modal';
import type { TextPopupBody, TextPopupSource } from './modal';
import type { TextPopupSettings } from './settings';
import { findSupportedElement } from './tags';

/**
 * 扫描锚点：核心为「可放大的区块」建立的共同容器。
 *
 * 依据（已在本机 obsidian.asar → app.js 中核对）：四类区块的 widget 基类都调
 * `addEditButton()` → `addAction()`，在容器内建 `.embed-actions` 放控制图标。
 * 容器本身都带 `.cm-embed-block`：
 *   - 块级原始 HTML  → `createEl("div", "cm-html-embed cm-embed-block")`
 *   - 围栏代码块     → `createDiv("cm-preview-code-block cm-embed-block … cm-lang-" + lang)`
 *                     （只对 `mermaid` / `query` / 有 post-processor 的语言成立，
 *                       普通语言如 `typescript` 不建 widget，见 CODE_FLAIR_SELECTOR）
 *   - Callout        → `createDiv("cm-embed-block cm-callout")`（`L3` 传入的 clazz）
 *   - 数学块         → `"math"` + `toggleClass("math-block" / "cm-embed-block")`
 * 表格（`.cm-table-widget`）等核心区块不带上面任何一个类名，由 `classifyBlock` 返回 null 过滤掉。
 *
 * 注：` ```base ` 块也带 `.cm-preview-code-block`（核心按代码块建容器，CSS 给它的 `.embed-actions`
 * 设了常显），因此按代码块处理 —— 与「有控制图标的区块才加放大图标」这条判据一致。
 */
const BLOCK_SELECTOR = '.cm-embed-block';
const ACTIONS_SELECTOR = ':scope > .embed-actions';
const ACTION_CLASS = 'text-popup-action';
const FLAIR_ACTION_CLASS = 'text-popup-flair-action';
const ACTION_LABEL = '放大显示文字';

/**
 * 第二处注入点：普通围栏代码块右上角的「语言名 / 复制」chip。
 *
 * 代码块在 Live Preview 里有两种形态（`obsidian.asar` → `app.js`）：
 *   - 语言被 `mermaid` / `query` / `base` 一类 post-processor 接管（`P3.canRenderLang(lang)` 为真）
 *     → 核心建 `.cm-preview-code-block.cm-embed-block` widget，图标走上面的 `.embed-actions` 路径；
 *   - **其它语言（如 `typescript`）核心不建 widget**：代码留成源码行（`HyperMD-codeblock`），只在
 *     开围栏行末尾挂一个 widget `E3`，`E3.toDOM` 就是 `createSpan({ cls: "code-block-flair" })`，
 *     内容是语言的显示名（语言为空时换成复制图标），点击即复制代码。
 * 后者没有 `.embed-actions`，所以放大图标只能嵌进这个 chip 里。
 *
 * 为什么嵌进 chip、而不是当兄弟节点插到 `.cm-line` 上：CM6 的 DOMObserver 会**忽略 widget 内部的**
 * DOM 变更（`readMutation` 里 `tile.isWidget()` 直接返回 null），而往 `.cm-line` 里塞一个它不认识的
 * 节点会被当成一次 DOM 变更、把整行标脏重渲染 —— 那会把按钮反复冲掉（注入 → 重渲染 → 再注入）。
 */
const CODE_FLAIR_SELECTOR = '.code-block-flair';
/** 离屏测量容器的类名（弹窗打开期间存在，关闭时移除）。 */
const MEASURE_CLASS = 'text-popup-measure';
const SCAN_DEBOUNCE_MS = 150;

/** 扫描器只需要插件的这几项能力，避免与 main.ts 形成循环依赖。 */
export interface TextPopupHost {
	app: App;
	settings: TextPopupSettings;
	register(cleanup: () => void): void;
	registerEvent(eventRef: EventRef): void;
}

/** 注册扫描：MutationObserver 覆盖编辑器重渲染，工作区事件覆盖切文件 / 切布局。 */
export function registerBlockScanner(host: TextPopupHost): void {
	const run = debounce(() => refreshTextPopupActions(host), SCAN_DEBOUNCE_MS);

	const observer = new MutationObserver(() => {
		run();
	});
	observer.observe(activeDocument.body, { childList: true, subtree: true });
	host.register(() => observer.disconnect());

	host.app.workspace.onLayoutReady(() => refreshTextPopupActions(host));
	host.registerEvent(host.app.workspace.on('layout-change', () => refreshTextPopupActions(host)));
	host.registerEvent(host.app.workspace.on('active-leaf-change', () => refreshTextPopupActions(host)));
	host.registerEvent(host.app.workspace.on('file-open', () => refreshTextPopupActions(host)));
}

/** 重新扫描并按当前设置同步按钮（设置变更、开关切换时也会调用）。 */
export function refreshTextPopupActions(host: TextPopupHost): void {
	if (!host.settings.enabled) {
		removeAllActions();
		return;
	}
	if (Platform.isMobile) return;

	// 一次遍历 + 类名分类：四类区块共用 `.cm-embed-block`，不必为每类各跑一次全文档查询。
	activeDocument.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((blockEl) => {
		const kind = classifyBlock(blockEl);
		if (!kind) return;
		if (isKindEnabled(host.settings, kind)) injectAction(blockEl, host, kind);
		// 该类被关掉时，把已注入的按钮摘掉（例如关掉「放大代码块」后立刻生效）
		else removeAction(blockEl);
	});

	// 第二处注入点：普通围栏代码块（非 widget）右上角的语言名 / 复制 chip，只吃「放大代码块」这一个开关。
	activeDocument.querySelectorAll<HTMLElement>(CODE_FLAIR_SELECTOR).forEach((flairEl) => {
		if (isKindEnabled(host.settings, 'code')) injectFlairAction(flairEl, host);
		else removeFlairAction(flairEl);
	});
}

/** 容器 → 类别；不属于本插件支持的四类时返回 null（表格等核心区块不参与）。 */
function classifyBlock(blockEl: HTMLElement): BlockKind | null {
	if (blockEl.classList.contains('cm-html-embed')) return 'html';
	if (blockEl.classList.contains('cm-preview-code-block')) return 'code';
	if (blockEl.classList.contains('cm-callout')) return 'callout';
	if (blockEl.classList.contains('math-block')) return 'math';
	return null;
}

/** 手写 HTML 块由「支持的标签」逐块判定，所以类别层面始终算开启。 */
function isKindEnabled(settings: TextPopupSettings, kind: BlockKind): boolean {
	return kind === 'html' ? true : settings.blockKinds[kind];
}

/** 移除本插件注入的全部按钮（禁用插件、关闭开关时使用）。 */
export function removeAllActions(): void {
	activeDocument.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}`).forEach((actionEl) => {
		actionEl.remove();
	});
}

/** 摘掉某个区块上的按钮（标签列表改小、或该类别被关掉时使用）。 */
function removeAction(blockEl: HTMLElement): void {
	blockEl.querySelector<HTMLElement>(`:scope > .embed-actions > .${ACTION_CLASS}`)?.remove();
}

/** 摘掉代码块 chip 里的按钮。 */
function removeFlairAction(flairEl: HTMLElement): void {
	flairEl.querySelector<HTMLElement>(`:scope > .${FLAIR_ACTION_CLASS}`)?.remove();
}

/** 与弹窗的空内容判据一致：有文字，或有子元素（例如块里只有一张图片）。 */
function hasContent(el: HTMLElement): boolean {
	return Boolean((el.textContent ?? '').trim()) || el.childElementCount > 0;
}

/** 打开一次弹窗时就定下来的候选快照：区间 + 惰性内容读取。 */
interface PopupCandidate {
	region: TextBlockRegion;
	/** 仅 html 类：离屏渲染出的元素，供「按内容兜底匹配」使用。 */
	target?: HTMLElement;
	read(): TextPopupBody | null;
}

/**
 * 离屏宿主：innerText 需要元素真实参与布局，所以不能用 display: none，只能移出可视区。
 * 挂在点击按钮所在的文档上，弹窗关闭时由 source.dispose 移除。
 */
function createOffscreenHost(doc: Document): HTMLElement {
	return doc.body.createDiv({
		cls: MEASURE_CLASS,
		attr: { 'aria-hidden': 'true' },
	});
}

/**
 * 被点击按钮所属的编辑器视图；找不到再退回活动视图。
 *
 * 不再用 `document.body` 兜底：那会把别的窗格 / 别的笔记里的块也算进候选集，
 * 是「数量可能超过本笔记块数」的入口。
 */
function findContainingView(app: App, actionEl: HTMLElement): MarkdownView | null {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.containerEl.contains(actionEl)) return view;
	}
	return app.workspace.getActiveViewOfType(MarkdownView);
}

/** 只需要 CM6 EditorView 的这一个方法，避免为了取类型而新增依赖。 */
type EditorViewLike = { posAtDOM(node: Node, offset?: number): number };

/**
 * 定位「用户点开的是第几个块」。
 *
 * 主路径：把被点击的按钮所属的块容器映射回文档偏移（CM6 的 EditorView.posAtDOM，经 Editor.cm 拿到），
 * 再落到行号区间上 —— 精确，且不受核心「按内容相同复用 widget」的影响。
 * 兜底：按内容相等匹配；再不行回 0（宁可从头开始，也不要弹空白）。
 *
 * 代码块 chip 里的按钮不在任何 `.cm-embed-block` 里，退回它所在的行（`.cm-line`）去定位：
 * chip 挂在开围栏那一行的末尾，因此这一行就是区间的起始行。这类锚点**只认精确命中**，
 * 对不上就返回 -1（弹窗不会开），避免「引用块里的围栏没有对应区间 → 翻出别的块」。
 */
function locateStartIndex(
	editor: Editor,
	actionEl: HTMLElement,
	candidates: readonly PopupCandidate[],
): number {
	const blockEl = actionEl.closest<HTMLElement>(BLOCK_SELECTOR);
	const lineEl = blockEl ?? actionEl.closest<HTMLElement>('.cm-line') ?? actionEl;
	const cm = (editor as unknown as { cm?: EditorViewLike }).cm;
	if (cm) {
		try {
			const line = editor.offsetToPos(cm.posAtDOM(lineEl)).line;
			if (!blockEl) return candidates.findIndex((c) => c.region.startLine === line);
			const hit = candidates.findIndex(
				(c) => line >= c.region.startLine && line <= c.region.endLine,
			);
			if (hit >= 0) return hit;
			// posAtDOM 可能落在区间前一行（块级 widget 的边界）：取第一个起点不早于它的候选
			const next = candidates.findIndex((c) => c.region.startLine >= line);
			if (next >= 0) return next;
		} catch (error) {
			console.error('[text-popup] posAtDOM 定位失败，改为按内容匹配', error);
		}
	}
	if (!blockEl) return -1;
	const key = extractText(blockEl);
	const byText = candidates.findIndex(
		(c) => c.target !== undefined && extractText(c.target) === key,
	);
	return byText >= 0 ? byText : 0;
}

/**
 * 组装一次弹窗会话的导航来源。
 *
 * 候选集来自**被点击按钮所在窗格的笔记文本**（`scanTextBlocks`，四类区间按类别开关过滤），不是 DOM：
 * Live Preview 只渲染视口附近的块，以 DOM 为准会让「总数」随滚动 / 光标 / 分屏变化。
 * 打开时算一次、提取一次，弹窗打开期间不再重采 —— 标题的总数与正文永远同源。
 */
export function createTextPopupSource(
	host: TextPopupHost,
	actionEl: HTMLElement,
): { source: TextPopupSource; startIndex: number } {
	const view = findContainingView(host.app, actionEl);
	const editor = view?.editor ?? null;
	const file = view?.file ?? host.app.workspace.getActiveFile();

	// 移出可视区但保持「被布局」：innerText 依赖布局，display: none 会让它退化成 textContent
	const measureEl = createOffscreenHost(actionEl.ownerDocument);
	measureEl.setCssStyles({
		position: 'fixed',
		top: '0',
		left: '-10000px',
		width: '700px',
		pointerEvents: 'none',
	});

	const candidates: PopupCandidate[] = [];
	for (const region of editor ? scanTextBlocks(editor.getValue()) : []) {
		if (!isKindEnabled(host.settings, region.kind)) continue;
		const candidate = createCandidate(region, host, measureEl);
		if (candidate) candidates.push(candidate);
	}

	const startIndex = editor ? locateStartIndex(editor, actionEl, candidates) : 0;

	return {
		startIndex,
		source: {
			// 快照：打开期间不再重采，标题的「总数 / 序号」与正文永远一致
			get size(): number {
				return candidates.length;
			},
			sourceName: file?.basename ?? '',
			// 链接 / 嵌入的解析基准必须是完整路径，basename 会导致相对解析失败。
			sourcePath: file?.path ?? '',
			read(index: number): TextPopupBody | null {
				return candidates[index]?.read() ?? null;
			},
			dispose(): void {
				measureEl.remove();
			},
		},
	};
}

/**
 * 一个区间 → 一个候选；内容为空（点了会弹空白屏）时返回 null。
 *
 * `html` 走 1.0.3 的老路：离屏 `sanitizeHTMLToDom` 渲染后按「支持的标签」找目标元素。
 * 另外三类是纯字符串处理，不需要 DOM，也不需要离屏宿主。
 */
function createCandidate(
	region: TextBlockRegion,
	host: TextPopupHost,
	measureEl: HTMLElement,
): PopupCandidate | null {
	if (region.kind === 'html') {
		// 与核心 widget 同样的渲染方式（公开 API sanitizeHTMLToDom），结构与编辑器里同源
		const holder = measureEl.createDiv();
		holder.appendChild(sanitizeHTMLToDom(region.raw));
		const target = findSupportedElement(holder, host.settings.supportedTags);
		if (!target || !hasContent(target)) return null;
		return {
			region,
			target,
			read: () => {
				const plain = extractText(target);
				const rich = host.settings.renderRichText ? extractRichSource(target) : '';
				return plain || rich ? { plain, rich } : null;
			},
		};
	}

	const plain = readTextBody(region);
	if (!plain) return null;
	return {
		region,
		read: () => {
			// rich 是区间原文：代码块 / Callout / 数学块都由 MarkdownRenderer 渲染成对应形态
			const rich = host.settings.renderRichText ? region.raw : '';
			return plain || rich ? { plain, rich } : null;
		},
	};
}

/** 三类原生区块的纯文本回退（关闭「渲染 HTML 与 Markdown」时显示的就是它）。 */
function readTextBody(region: TextBlockRegion): string {
	switch (region.kind) {
		case 'code':
			return extractFencedBody(region.raw);
		case 'callout':
			return extractCalloutBody(region.raw);
		case 'math':
			return extractMathBody(region.raw);
		default:
			return '';
	}
}

/** 往 `.embed-actions` 里注入放大图标（widget 类区块：HTML 块 / Callout / 数学块 / 被接管的代码块）。 */
function injectAction(blockEl: HTMLElement, host: TextPopupHost, kind: BlockKind): void {
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
 * 往普通代码块右上角的 chip（`.code-block-flair`）里注入放大图标。
 *
 * 与 `.embed-actions` 版本的区别只有锚点：chip 里没有图标槽位，所以按钮是 chip 的**子节点**
 * （`inline` → span，样式见 styles.css 的 `.text-popup-flair-action`）。嵌在 widget 内部这一点
 * 是刻意的：CM6 会忽略 widget 内部的 DOM 变更，按钮不会被「看不懂的 DOM 变更」反复冲掉。
 */
function injectFlairAction(flairEl: HTMLElement, host: TextPopupHost): void {
	// 引用块 / Callout 源码里的围栏行首带 `>`，扫描器不当候选（见 blocks.ts），因此不挂按钮：
	// 哪怕哪天这类行真挂上了 chip，也不会出现「点开却翻出别的块」。实测当前版本核心不给它们建 chip。
	if (flairEl.closest('.cm-line')?.classList.contains('HyperMD-quote')) return;
	if (flairEl.querySelector<HTMLElement>(`:scope > .${FLAIR_ACTION_CLASS}`)) return;
	flairEl.appendChild(createActionEl(flairEl, host, FLAIR_ACTION_CLASS, true));
}

/**
 * 建按钮并接好交互 —— 两处锚点共用。
 *
 * `inline` 用 span：代码块 chip 是行内的 `display: inline-block`，div 会在里面另起一行。
 * interactive-child 是核心约定的「交互子元素」标记：核心的点击接管与双击进块都会跳过它。
 * 图标用 maximize-2 而不是 zoom-in，避免与弹窗控制条上的「整体放大」图标混淆。
 */
function createActionEl(
	parent: HTMLElement,
	host: TextPopupHost,
	classes: string,
	inline = false,
): HTMLElement {
	const cls = `${classes} interactive-child ${ACTION_CLASS}`;
	const actionEl = inline ? parent.createSpan({ cls }) : parent.createDiv({ cls });
	actionEl.setAttribute('role', 'button');
	actionEl.setAttribute('tabindex', '0');
	actionEl.setAttribute('aria-label', ACTION_LABEL);
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
