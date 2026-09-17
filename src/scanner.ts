import { debounce, MarkdownView, Platform, sanitizeHTMLToDom, setIcon } from 'obsidian';
import type { App, Editor, EventRef } from 'obsidian';
import { extractRichSource, extractText } from './extract';
import { scanHtmlBlocks } from './htmlBlocks';
import { TextPopupModal } from './modal';
import type { TextPopupBody, TextPopupSource } from './modal';
import type { TextPopupSettings } from './settings';
import { findSupportedElement } from './tags';

/**
 * 扫描锚点：块级原始 HTML 的专属容器。
 *
 * 依据（已在本机 Obsidian 应用包中核对）：
 *   this.containerEl = createEl(block ? "div" : "span",
 *       "cm-html-embed" + (block ? " cm-embed-block" : ""));
 *   if (block) this.addEditButton(e, containerEl);   // 仅块级才建 .embed-actions
 * 只有它是「用户手写的 HTML」，因此零误报；按标签名扫描则会误伤 Markdown 生成的 <p>。
 */
const BLOCK_SELECTOR = '.cm-html-embed.cm-embed-block';
const ACTIONS_SELECTOR = ':scope > .embed-actions';
const ACTION_CLASS = 'text-popup-action';
const ACTION_LABEL = '放大显示文字';
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

	activeDocument.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((blockEl) => {
		injectAction(blockEl, host);
	});
}

/** 移除本插件注入的全部按钮（禁用插件、关闭开关时使用）。 */
export function removeAllActions(): void {
	activeDocument.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}`).forEach((actionEl) => {
		actionEl.remove();
	});
}

/** 与弹窗的空内容判据一致：有文字，或有子元素（例如块里只有一张图片）。 */
function hasContent(el: HTMLElement): boolean {
	return Boolean((el.textContent ?? '').trim()) || el.childElementCount > 0;
}

/** 打开一次弹窗时就定下来的候选快照：区间 + 提取内容的元素。 */
interface PopupCandidate {
	startLine: number;
	endLine: number;
	/** 区间文本渲染出来的元素（离屏），弹窗从这里提取 plain / rich。 */
	target: HTMLElement;
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
 * 主路径：把被点击的块容器映射回文档偏移（CM6 的 EditorView.posAtDOM，经 Editor.cm 拿到），
 * 再落到行号区间上 —— 精确，且不受核心「按内容相同复用 widget」的影响。
 * 兜底：按内容相等匹配；再不行回 0（宁可从头开始，也不要弹空白）。
 */
function locateStartIndex(
	editor: Editor,
	actionEl: HTMLElement,
	candidates: readonly PopupCandidate[],
): number {
	const blockEl = actionEl.closest<HTMLElement>(BLOCK_SELECTOR) ?? actionEl;
	const cm = (editor as unknown as { cm?: EditorViewLike }).cm;
	if (cm) {
		try {
			const line = editor.offsetToPos(cm.posAtDOM(blockEl)).line;
			const hit = candidates.findIndex((c) => line >= c.startLine && line <= c.endLine);
			if (hit >= 0) return hit;
			// posAtDOM 可能落在区间前一行（块级 widget 的边界）：取第一个起点不早于它的候选
			const next = candidates.findIndex((c) => c.startLine >= line);
			if (next >= 0) return next;
		} catch (error) {
			console.error('[text-popup] posAtDOM 定位失败，改为按内容匹配', error);
		}
	}
	const key = extractText(blockEl);
	const byText = candidates.findIndex((c) => extractText(c.target) === key);
	return byText >= 0 ? byText : 0;
}

/**
 * 组装一次弹窗会话的导航来源。
 *
 * 候选集来自**被点击按钮所在窗格的笔记文本**（`scanHtmlBlocks`），不是 DOM：
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
	for (const block of editor ? scanHtmlBlocks(editor.getValue()) : []) {
		// 与核心 widget 同样的渲染方式（公开 API sanitizeHTMLToDom），结构与编辑器里同源
		const holder = measureEl.createDiv();
		holder.appendChild(sanitizeHTMLToDom(block.raw));
		const target = findSupportedElement(holder, host.settings.supportedTags);
		// 空块今天点了也不弹窗，直接排除，免得方向键切到一屏空白
		if (target && hasContent(target)) candidates.push({ ...block, target });
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
				const target = candidates[index]?.target;
				if (!target) return null;
				const plain = extractText(target);
				const rich = host.settings.renderRichText ? extractRichSource(target) : '';
				return plain || rich ? { plain, rich } : null;
			},
			dispose(): void {
				measureEl.remove();
			},
		},
	};
}

function injectAction(blockEl: HTMLElement, host: TextPopupHost): void {
	const actionsEl = blockEl.querySelector<HTMLElement>(ACTIONS_SELECTOR);
	if (!actionsEl) return;

	// 幂等判据：按钮是否已存在。核心重渲染后 DOM 被重建，这里会自动补回。
	const existingEl = actionsEl.querySelector<HTMLElement>(`:scope > .${ACTION_CLASS}`);
	const target = findSupportedElement(blockEl, host.settings.supportedTags);

	if (!target) {
		// 标签列表被改小之后，清理不再符合条件的按钮。
		existingEl?.remove();
		return;
	}
	if (existingEl) return;

	// interactive-child 是核心约定的「交互子元素」标记：核心的点击接管与双击进块都会跳过它。
	// 图标用 maximize-2 而不是 zoom-in，避免与弹窗控制条上的「整体放大」图标混淆。
	const actionEl = actionsEl.createDiv({ cls: `embed-action interactive-child ${ACTION_CLASS}` });
	actionEl.setAttribute('role', 'button');
	actionEl.setAttribute('tabindex', '0');
	actionEl.setAttribute('aria-label', ACTION_LABEL);
	setIcon(actionEl, 'maximize-2');

	const open = (evt?: Event): void => {
		// 核心在 widget 容器上挂了「点击即进入块内编辑」的延迟处理：它先看 defaultPrevented，
		// 所以这里拦下就能避免「光标跳进块里 + 编辑器滚动 + 本块图标被销毁」。
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

	// 插到首位 → 位于「编辑这个模块」图标左侧（RTL 由核心样式自动镜像）。
	actionsEl.insertBefore(actionEl, actionsEl.firstChild);
}
