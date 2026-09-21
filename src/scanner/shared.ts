/**
 * scanner 模块的共享常量、类型与分类函数。
 */

import type { BlockKind } from '../blocks';
import type { Extension } from '@codemirror/state';
import type { App, EventRef } from 'obsidian';
import type { TextPopupSettings } from '../settings';

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
 * 表格（`.cm-table-widget`）**同样**带这条类名（真机实测容器 class = `cm-embed-block
 * cm-table-widget markdown-rendered`），所以既有遍历本来就扫得到它；但核心没给表格调
 * `addEditButton()`，它**没有**现成的 `.embed-actions` —— 图标容器由本插件自己建
 * （见 inject.ts 的 `injectTableAction`）。其余核心区块（如 `.cm-lang-base`）仍由
 * `classifyBlock` 返回 null 过滤掉。
 * 图片嵌入**不在**这条选择器里（它的容器是 `.image-embed`），单独走 `IMAGE_SELECTOR`。
 */
export const BLOCK_SELECTOR = '.cm-embed-block';
export const ACTIONS_SELECTOR = ':scope > .embed-actions';
export const ACTION_CLASS = 'text-popup-action';
export const FLAIR_ACTION_CLASS = 'text-popup-flair-action';

/**
 * 表格的图标容器类名：`embed-actions` 用来复核心的皮肤（绝对定位 / 右上角 4px / flex / gap /
 * 默认透明），`text-popup-table-actions` 用来**认领**这个容器 —— 摘按钮时要连容器一起摘，
 * 且绝不能误删核心自己建的 `.embed-actions`。
 */
export const TABLE_ACTIONS_CLASS = 'text-popup-table-actions';

/**
 * 第二处注入点：普通围栏代码块右上角的「语言名 / 复制」chip。
 * （详见 inject.ts 的 `injectFlairAction`）
 */
export const CODE_FLAIR_SELECTOR = '.code-block-flair';

/**
 * 第三处注入点：图片嵌入（容器是 `.image-embed`，不带 `.cm-embed-block`）。
 * （详见 inject.ts 的 `injectImageAction`）
 */
export const IMAGE_SELECTOR = '.cm-content .image-embed';

/**
 * 第四处注入点：Markdown 引用块（`> …`）—— 唯一**不是** DOM 注入的一处。
 *
 * 引用行在实时预览里没有容器（实测普通引用行上一条 `.cm-embed-block` 都没有），往 `.cm-line`
 * 里插的节点又会被 CM6 的 DOMObserver 冲掉，所以图标由 `scanner/quote.ts` 的 CodeMirror
 * 装饰器（`ViewPlugin` + `Decoration.widget`）承载，DOM 归 CM6 托管。
 * 这里只留下「怎么认出一条引用行」的类名与它的容器类名。
 */
export const QUOTE_LINE_SELECTOR = '.cm-line.HyperMD-quote';

/**
 * 第五处注入点：Markdown 表格（容器是 `.cm-table-widget`，**带** `.cm-embed-block`）。
 *
 * 它是唯一「容器在、图标容器不在」的一处：核心不给表格调 `addEditButton()`，所以没有现成的
 * `.embed-actions` 可插，由本插件在 `.table-wrapper` 里自己建一个（见 inject.ts 的
 * `injectTableAction`）。锚在 `.table-wrapper` 而不是 widget 容器：后者常被拉满行宽
 * （实测 732px vs 表格 347px），按钮会飘到编辑区右缘。
 */
export const TABLE_WIDGET_CLASS = 'cm-table-widget';

/** 离屏测量容器的类名（弹窗打开期间存在，关闭时移除）。 */
export const MEASURE_CLASS = 'text-popup-measure';
export const SCAN_DEBOUNCE_MS = 150;

/** 扫描器只需要插件的这几项能力，避免与 main.ts 形成循环依赖。 */
export interface TextPopupHost {
	app: App;
	settings: TextPopupSettings;
	register(cleanup: () => void): void;
	registerEvent(eventRef: EventRef): void;
	/**
	 * 往编辑器里挂一个 CodeMirror 扩展（`Plugin.registerEditorExtension` 的同名签名）。
	 *
	 * 只有引用块用得上它：引用行没有容器、也不能往行里插 DOM，它的放大图标必须由 CM6 托管的
	 * 装饰器承载（见 `scanner/quote.ts`）。`main.ts` 传进来的 `this` 本来就有这个方法。
	 */
	registerEditorExtension(extension: Extension): void;
}

/**
 * 组装候选集 / 弹窗会话只需要这两项能力（注入用的 `register` / `registerEvent` 不在其中）。
 *
 * 拆出来是为了让命令层也能复用同一套组装：`commands.ts` 的 `CommandHost` 有 `app` 与
 * `settings`、但不含 `register`，结构上正好满足这个更窄的类型，不必为了共用一个函数
 * 而给命令层塞进它用不到的注册能力。
 */
export type PopupSessionHost = Pick<TextPopupHost, 'app' | 'settings'>;

/** 打开一次弹窗时就定下来的候选快照：区间 + 惰性内容读取。 */
export interface PopupCandidate {
	region: import('../blocks').TextBlockRegion;
	/** 仅 html 类：离屏渲染出的元素，供「按内容兜底匹配」使用。 */
	target?: HTMLElement;
	read(): import('../modal').TextPopupBody | null;
}

/** 只需要 CM6 EditorView 的这一个方法，避免为了取类型而新增依赖。 */
export type EditorViewLike = { posAtDOM(node: Node, offset?: number): number };

/**
 * 容器 → 类别；不属于这条路支持的类别时返回 null（其余核心区块仍不参与）。
 * 图片嵌入不经过这里（容器是 `.image-embed`，见 `IMAGE_SELECTOR`）；
 * 表格容器带 `.cm-embed-block`，所以走这里分类（它的注入锚点另在 `.table-wrapper`）。
 */
export function classifyBlock(blockEl: HTMLElement): BlockKind | null {
	if (blockEl.classList.contains('cm-html-embed')) return 'html';
	if (blockEl.classList.contains('cm-preview-code-block')) return 'code';
	if (blockEl.classList.contains('cm-callout')) return 'callout';
	if (blockEl.classList.contains('math-block')) return 'math';
	if (blockEl.classList.contains(TABLE_WIDGET_CLASS)) return 'table';
	return null;
}

/** 手写 HTML 块由「支持的标签」逐块判定，所以类别层面始终算开启。 */
export function isKindEnabled(settings: TextPopupSettings, kind: BlockKind): boolean {
	return kind === 'html' ? true : settings.blockKinds[kind];
}

/** 与弹窗的空内容判据一致：有文字，或有子元素（例如块里只有一张图片）。 */
export function hasContent(el: HTMLElement): boolean {
	return Boolean((el.textContent ?? '').trim()) || el.childElementCount > 0;
}
