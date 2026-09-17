import { debounce, Platform, setIcon } from 'obsidian';
import type { App, EventRef } from 'obsidian';
import { extractRichSource, extractText } from './extract';
import { TextPopupModal } from './modal';
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
		const plain = extractText(target);
		const rich = host.settings.renderRichText ? extractRichSource(target) : '';
		if (!plain && !rich) return;
		const file = host.app.workspace.getActiveFile();
		new TextPopupModal(
			host.app,
			{
				plain,
				rich,
				sourceName: file?.basename ?? '',
				// 链接 / 嵌入的解析基准必须是完整路径，basename 会导致相对解析失败。
				sourcePath: file?.path ?? '',
			},
			host.settings,
		).open();
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
