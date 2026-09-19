/**
 * scanner 模块对外门面：注册扫描、刷新按钮、移除全部按钮。
 *
 * 重新导出 `TextPopupHost` / `createTextPopupSource` / `openFirstTextPopup`，
 * 外部调用方的 `import … from './scanner'` 无需改动。
 */

import { debounce, Platform } from 'obsidian';
import { injectAction, injectFlairAction, injectImageAction, removeAction, removeFlairAction } from './inject';
import { createTextPopupSource, openFirstTextPopup } from './session';
import {
	ACTION_CLASS,
	BLOCK_SELECTOR,
	classifyBlock,
	CODE_FLAIR_SELECTOR,
	IMAGE_SELECTOR,
	isKindEnabled,
	SCAN_DEBOUNCE_MS,
} from './shared';
import type { TextPopupHost } from './shared';

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

	// 一次遍历 + 类名分类：走 `.cm-embed-block` 的四类区块共用它，不必为每类各跑一次全文档查询。
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

	// 第三处注入点：图片嵌入（容器是 `.image-embed`，不带 `.cm-embed-block`）。
	activeDocument.querySelectorAll<HTMLElement>(IMAGE_SELECTOR).forEach((imageEl) => {
		if (isKindEnabled(host.settings, 'image')) injectImageAction(imageEl, host);
		else removeAction(imageEl);
	});
}

/** 移除本插件注入的全部按钮（禁用插件、关闭开关时使用）。 */
export function removeAllActions(): void {
	activeDocument.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}`).forEach((actionEl) => {
		actionEl.remove();
	});
}

export { createTextPopupSource, openFirstTextPopup };
export type { TextPopupHost };
