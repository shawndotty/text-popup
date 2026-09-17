import { debounce, MarkdownView, Platform, setIcon } from 'obsidian';
import type { App, EventRef } from 'obsidian';
import { extractRichSource, extractText } from './extract';
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

/** 一个导航候选：内容元素 + 它对应的放大按钮。 */
interface PopupEntry {
	/** 被标记的内容元素，弹窗从这里提取文字。 */
	target: HTMLElement;
	/** 该块上已注入的放大按钮，用来定位「当前点开的是哪一个」。 */
	actionEl: HTMLElement;
}

/** 与弹窗的空内容判据一致：有文字，或有子元素（例如块里只有一张图片）。 */
function hasContent(el: HTMLElement): boolean {
	return Boolean((el.textContent ?? '').trim()) || el.childElementCount > 0;
}

/**
 * 采集一个窗格内的全部导航候选，按文档顺序。
 *
 * 以「已注入的放大按钮」为准，而不是重新跑一遍标签匹配：这样导航顺序必然等于用户看到的
 * 图标顺序，也自动继承标签设置、启用开关与平台判断，不必再维护第二套「什么算被标记」的判据。
 */
function collectEntries(paneEl: HTMLElement, tags: readonly string[]): PopupEntry[] {
	const entries: PopupEntry[] = [];
	paneEl.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}`).forEach((actionEl) => {
		const blockEl = actionEl.closest<HTMLElement>(BLOCK_SELECTOR);
		if (!blockEl) return;
		const target = findSupportedElement(blockEl, tags);
		// 空块今天点了也不弹窗，直接排除，免得方向键切到一屏空白
		if (target && hasContent(target)) entries.push({ target, actionEl });
	});
	return entries;
}

/**
 * 组装一次弹窗会话的导航来源。
 *
 * 采集基准固定为「点击时所在的那个编辑器窗格」：多窗格并排打开同一笔记时，
 * 方向键只在点击的那个窗格内切换，不会跳到另一个窗格。
 */
export function createTextPopupSource(
	host: TextPopupHost,
	actionEl: HTMLElement,
): { source: TextPopupSource; startIndex: number } {
	const view = host.app.workspace.getActiveViewOfType(MarkdownView);
	let paneEl = view?.containerEl ?? actionEl.ownerDocument.body;
	const file = host.app.workspace.getActiveFile();
	const collect = (): PopupEntry[] => collectEntries(paneEl, host.settings.supportedTags);

	// 按钮与候选来自同一批 DOM、同一个 findSupportedElement，节点身份一致，可直接按按钮定位序号
	let startIndex = collect().findIndex((entry) => entry.actionEl === actionEl);
	if (startIndex < 0) {
		// 活动窗格与按钮所在窗格不是同一个（例如点在非活动窗格上）：退回全窗口采集，
		// 保证「点哪个块就显示哪个块」不回归，代价是候选集可能跨窗格。
		paneEl = actionEl.ownerDocument.body;
		startIndex = Math.max(0, collect().findIndex((entry) => entry.actionEl === actionEl));
	}

	return {
		startIndex,
		source: {
			// 每次都按当前 DOM 重采：弹窗打开期间编辑器重渲染（例如另一个窗格在编辑同一笔记）
			// 会替换掉块节点，用快照会读到已脱离文档的元素。
			get size(): number {
				return collect().length;
			},
			sourceName: file?.basename ?? '',
			// 链接 / 嵌入的解析基准必须是完整路径，basename 会导致相对解析失败。
			sourcePath: file?.path ?? '',
			read(index: number): TextPopupBody | null {
				const target = collect()[index]?.target;
				if (!target) return null;
				const plain = extractText(target);
				const rich = host.settings.renderRichText ? extractRichSource(target) : '';
				return plain || rich ? { plain, rich } : null;
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

	const actionEl = actionsEl.createDiv({ cls: `embed-action ${ACTION_CLASS}` });
	actionEl.setAttribute('role', 'button');
	actionEl.setAttribute('tabindex', '0');
	actionEl.setAttribute('aria-label', ACTION_LABEL);
	setIcon(actionEl, 'zoom-in');

	const open = (): void => {
		const { source, startIndex } = createTextPopupSource(host, actionEl);
		// 空块不弹窗：与 1.0.2 的 `if (!plain && !rich) return;` 等价
		if (!source.read(startIndex)) return;
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
