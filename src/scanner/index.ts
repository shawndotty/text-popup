/**
 * scanner 模块对外门面：注册扫描、刷新按钮、移除全部按钮。
 *
 * 重新导出 `TextPopupHost` / `createTextPopupSource` / `openFirstTextPopup` / `notifyQuoteActionsChanged`，
 * 外部调用方的 `import … from './scanner'` 无需改动。
 */

import { debounce, Platform } from 'obsidian';
import {
	injectAction,
	injectFlairAction,
	injectImageAction,
	injectTableAction,
	removeAction,
	removeFlairAction,
	removeTableAction,
} from './inject';
import { notifyQuoteActionsChanged, quoteActionsExtension, registerQuoteHover, QUOTE_ACTION_CLASS } from './quote';
import { createTextPopupSource, openFirstTextPopup } from './session';
import {
	ACTION_CLASS,
	BLOCK_SELECTOR,
	classifyBlock,
	CODE_FLAIR_SELECTOR,
	IMAGE_SELECTOR,
	isKindEnabled,
	SCAN_DEBOUNCE_MS,
	TABLE_ACTIONS_CLASS,
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

	// 第四处注入点：引用块。走 CodeMirror 装饰器（不是 DOM 注入），注册一次即可，
	// 卸载时由 Obsidian 自动摘掉扩展；悬停显隐靠一次委托监听，随插件一起清理。
	host.registerEditorExtension(quoteActionsExtension(host));
	registerQuoteHover(host);
}

/**
 * 重新扫描并按当前设置同步按钮（设置变更、开关切换时也会调用）。
 *
 * 只管**由本函数负责**的注入点（`.cm-embed-block` 一族含表格、`.code-block-flair`、图片那处）；
 * **引用块不在这里**：它的图标由 CM6 装饰器托管、随文档变更自动重算，设置变更则走
 * `notifyQuoteActionsChanged`（见 `scanner/quote.ts`，那里也写清了为什么不能塞进这条路径）。
 */
export function refreshTextPopupActions(host: TextPopupHost): void {
	if (!host.settings.enabled) {
		removeAllActions();
		return;
	}
	if (Platform.isMobile) return;

	// 一次遍历 + 类名分类：走 `.cm-embed-block` 的四类区块与表格共用它，不必为每类各跑一次全文档查询。
	activeDocument.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((blockEl) => {
		const kind = classifyBlock(blockEl);
		if (!kind) return;
		if (!isKindEnabled(host.settings, kind)) {
			// 该类被关掉时，把已注入的按钮摘掉（例如关掉「放大代码块」后立刻生效）
			// 表格的容器是本插件自建的、锚点也不同，要连容器一起摘（见 removeTableAction）
			if (kind === 'table') removeTableAction(blockEl);
			else removeAction(blockEl);
			return;
		}
		if (kind === 'table') injectTableAction(blockEl, host);
		else injectAction(blockEl, host, kind);
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

/**
 * 移除本插件注入的全部按钮（禁用插件、关闭开关时使用）。
 *
 * 必须跳过引用块的按钮（`.text-popup-quote-action`）：它的 DOM 归 CM6 的装饰器托管，
 * 删掉之后 widget 会变成空壳、**不会自己长回来**（装饰集没变、CM6 不会重建 widget）。
 * 引用块图标的显隐由装饰集控制：关总开关时 `notifyQuoteActionsChanged` 把装饰集清空。
 */
export function removeAllActions(): void {
	activeDocument
		.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}:not(.${QUOTE_ACTION_CLASS})`)
		.forEach((actionEl) => {
			actionEl.remove();
		});

	// 表格的图标容器是本插件自己建的（不是核心建的 .embed-actions）：只删按钮会留下空壳，
	// 所以这里连容器一起清掉（`removeTableAction` 走的是区块 → 容器的路径，禁插件时无从下手）。
	activeDocument
		.querySelectorAll<HTMLElement>(`.${TABLE_ACTIONS_CLASS}`)
		.forEach((actionsEl) => {
			actionsEl.remove();
		});
}

export { createTextPopupSource, openFirstTextPopup, notifyQuoteActionsChanged };
export type { TextPopupHost };
