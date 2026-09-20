/**
 * 引用块（`> …`）的放大图标 —— 本插件唯一一处**不是 DOM 注入**的注入点。
 *
 * 为什么不用老办法（`inject.ts` 那三处）：引用块在实时预览里没有容器。它只是一串
 * `.cm-line.HyperMD-quote`（实测 17 条引用行上一条 `.cm-embed-block` 都没有），而往
 * `.cm-line` 里 `appendChild` 的节点会被 CM6 的 `DOMObserver` 当成文档变更、整行重渲染时冲掉
 * （实测 2 秒内消失，与 README 里「代码块 chip 必须嵌在 widget 内部」同因）。
 *
 * 所以这里走核心自己在普通行上用的那条路 —— 对照核心的 `.code-block-flair`：它就是
 * `.cm-line.HyperMD-codeblock-begin` 里的一个绝对定位元素。这里用一个 CM6 装饰器 widget
 * 承载按钮，DOM 由 CM6 托管：不会被冲掉，定位也白拿（`.cm-line` 是 `position: relative`，
 * 核心的 `.embed-actions` 皮肤自带「绝对定位 + 右上角 + 默认透明」）。
 *
 * 与候选集的关系：区间仍由 `blocks.ts` 的 `scanTextBlocks` 算出（`kind === 'quote'`），
 * 这里只负责把图标画上去。两侧必须用**同一个** `scanTextBlocks` + `isKindEnabled`，
 * 否则会出现「有图标没候选」或「有候选没图标」的幽灵。
 */

import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { Platform } from 'obsidian';
import { scanTextBlocks } from '../blocks';
import type { TextBlockRegion } from '../blocks';
import { createActionEl } from './inject';
import { readTextBody } from './session';
import { isKindEnabled, QUOTE_LINE_SELECTOR } from './shared';
import type { TextPopupHost } from './shared';

/**
 * 设置变更信号：让每个打开的编辑器重建一次装饰集（关掉「放大引用块」时要**立刻**生效）。
 *
 * 只能由设置页调用，见 `notifyQuoteActionsChanged` 里的自激说明。
 */
export const refreshQuoteActionsEffect = StateEffect.define<null>();

/** 容器额外类名：`embed-actions` 是核心皮肤，这个类只用于插件自己的显隐与豁免（`removeAllActions`）。 */
export const QUOTE_ACTIONS_CLASS = 'text-popup-quote-actions';
/** 按钮额外类名：`removeAllActions` 必须跳过它（widget 的 DOM 归 CM6 管，不能由我们 remove）。 */
export const QUOTE_ACTION_CLASS = 'text-popup-quote-action';
/** 悬停标记：悬停块内任意一行时写在容器上，CSS 据此显形（见 styles.css）。 */
export const QUOTE_HOVER_ATTR = 'data-text-popup-hover';

/** 一个引用块一个 widget：DOM 就是核心那套胶囊 + 一个按钮。 */
class QuoteActionWidget extends WidgetType {
	constructor(
		private readonly host: TextPopupHost,
		private readonly region: TextBlockRegion,
	) {
		super();
	}

	/** 区间没变就等价（CM6 会沿用同一份 widget，不重建 DOM）。 */
	eq(other: QuoteActionWidget): boolean {
		return (
			other.region.startLine === this.region.startLine &&
			other.region.endLine === this.region.endLine
		);
	}

	toDOM(): HTMLElement {
		// `createDiv` 是 Obsidian 的**全局**助手（核心自己也是裸用），不在 `obsidian` 模块的导出里，
		// 所以不能 import —— 类型来自 obsidian.d.ts 的 `declare global`。
		const actionsEl = createDiv({ cls: `embed-actions ${QUOTE_ACTIONS_CLASS}` });
		const buttonEl = createActionEl(actionsEl, this.host, 'embed-action');
		buttonEl.addClass(QUOTE_ACTION_CLASS);
		actionsEl.appendChild(buttonEl);
		return actionsEl;
	}

	// 不覆写 ignoreEvent()：默认 true = 编辑器忽略 widget 内部的事件（点图标不会挪光标 / 不会进块编辑）
}

/**
 * 扫描全文 → 引用块区间 → 每块一个 widget，挂在**首行行尾**（图标因此落在块的右上角，与核心一致）。
 *
 * 三处过滤各有理由：
 * - `Platform.isMobile`：移动端没有悬停，与内置图片图标的行为一致；
 * - 总开关 / 类别开关：关掉后装饰集为空，图标立刻消失；
 * - `readTextBody` 为空：只有 `> ` 的引用块在候选集里也不产条目（`createCandidate` 会返回 null），
 *   不在这里一起过滤就会出现「有图标、点开没反应」。
 */
function buildDecorations(view: EditorView, host: TextPopupHost): DecorationSet {
	if (Platform.isMobile) return Decoration.none;
	if (!host.settings.enabled || !isKindEnabled(host.settings, 'quote')) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	for (const region of scanTextBlocks(view.state.doc.toString())) {
		if (region.kind !== 'quote') continue;
		if (!readTextBody(region)) continue;
		const line = view.state.doc.line(region.startLine + 1);
		builder.add(
			line.to,
			line.to,
			Decoration.widget({
				widget: new QuoteActionWidget(host, region),
				side: 1, // 挂在行尾文本之后
			}),
		);
	}
	return builder.finish();
}

/** 编辑器扩展本体：文档变更或收到刷新信号时重算装饰集。 */
export function quoteActionsExtension(host: TextPopupHost): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, host);
			}

			update(update: ViewUpdate): void {
				const forced = update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(refreshQuoteActionsEffect)),
				);
				if (update.docChanged || forced) this.decorations = buildDecorations(update.view, host);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

/**
 * 设置变了 → 让每个打开的编辑器重建一次装饰集（关掉开关时图标要**立刻**消失）。
 *
 * 只能由设置页调用，**绝不能**塞进 `refreshTextPopupActions` 的观察者路径：那条路径本身由
 * MutationObserver 触发，而 dispatch 会改 DOM（widget 增删）→ 又触发观察者 → 自激循环。
 */
export function notifyQuoteActionsChanged(host: TextPopupHost): void {
	for (const leaf of host.app.workspace.getLeavesOfType('markdown')) {
		const cm = (leaf.view as unknown as { editor?: { cm?: EditorView } }).editor?.cm;
		cm?.dispatch({ effects: refreshQuoteActionsEffect.of(null) });
	}
}

/**
 * 悬停引用块里的任意一行都显示这一块的图标。
 *
 * 图标挂在**首行**（块有多行时 `:hover` 只能覆盖首行），所以这里做一次事件委托：
 * 委托监听 mouseover / mouseout，不逐行挂监听。`previousElementSibling` 上溯到首行 ——
 * 引用行在 DOM 里是连续兄弟（真机实测），上溯到的就是区间起始行（widget 所在的那一行）。
 */
export function registerQuoteHover(host: TextPopupHost): void {
	const firstLineOf = (lineEl: HTMLElement): HTMLElement => {
		let first = lineEl;
		while (first.previousElementSibling?.classList.contains('HyperMD-quote')) {
			first = first.previousElementSibling as HTMLElement;
		}
		return first;
	};

	const clear = (): void => {
		activeDocument
			.querySelectorAll<HTMLElement>(`.${QUOTE_ACTIONS_CLASS}[${QUOTE_HOVER_ATTR}]`)
			.forEach((el) => el.removeAttribute(QUOTE_HOVER_ATTR));
	};

	const onOver = (evt: Event): void => {
		const target = evt.target;
		const lineEl =
			target instanceof HTMLElement ? target.closest<HTMLElement>(QUOTE_LINE_SELECTOR) : null;
		// 每次重算：mouseover 会在任意元素切换时冒泡上来，天然覆盖「换行 / 移出」
		clear();
		if (!lineEl) return;
		firstLineOf(lineEl)
			.querySelector<HTMLElement>(`:scope > .${QUOTE_ACTIONS_CLASS}`)
			?.setAttribute(QUOTE_HOVER_ATTR, 'true');
	};

	const onOut = (evt: Event): void => {
		const related = (evt as MouseEvent).relatedTarget;
		if (related instanceof HTMLElement && related.closest(QUOTE_LINE_SELECTOR)) return;
		clear();
	};

	activeDocument.addEventListener('mouseover', onOver);
	activeDocument.addEventListener('mouseout', onOut);
	host.register(() => {
		activeDocument.removeEventListener('mouseover', onOver);
		activeDocument.removeEventListener('mouseout', onOut);
	});
}
