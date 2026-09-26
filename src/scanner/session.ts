/**
 * scanner 模块的弹窗会话组装：从笔记文本构建候选集、定位起点、打开弹窗。
 */

import { MarkdownView, sanitizeHTMLToDom } from 'obsidian';
import type { Editor, TFile } from 'obsidian';
import { scanTextBlocks } from '../blocks';
import type { TextBlockRegion } from '../blocks';
import { parseCanvasDocument, renderCanvasSnapshot } from '../canvas';
import type { CanvasDocument } from '../canvas';
// 七类的纯文本回退已迁到 `extract.ts`（`readTextBody`）：过滤层要用它算搜索文本，
// 留在 scanner 里会让 `filter.ts` 反向依赖弹窗 / 画布那一整条链。
import {
	extractCanvasBody,
	extractImageBody,
	extractRichSource,
	extractText,
	isExcalidrawEmbed,
	readTextBody,
	resolveCanvasFile,
	resolveExcalidrawImage,
} from '../extract';
import { entrySearchText, entryTypeOf } from '../filter';
import type { PopupEntry } from '../filter';
import { TextPopupModal } from '../modal';
import type { TextPopupBody, TextPopupSource } from '../modal';
import { findSupportedElement } from '../tags';
import {
	BLOCK_SELECTOR,
	containingMarkdownView,
	hasContent,
	isKindEnabled,
	MEASURE_CLASS,
	type EditorViewLike,
	type PopupCandidate,
	type PopupSessionHost,
} from './shared';

/**
 * 离屏宿主：innerText 需要元素真实参与布局，所以不能用 display: none，只能移出可视区。
 * 挂在按钮所在的文档上（命令入口用 `activeDocument`），弹窗关闭时由 source.dispose 移除。
 */
export function createOffscreenHost(doc: Document): HTMLElement {
	const measureEl = doc.body.createDiv({
		cls: MEASURE_CLASS,
		attr: { 'aria-hidden': 'true' },
	});
	measureEl.setCssStyles({
		position: 'fixed',
		top: '0',
		left: '-10000px',
		width: '700px',
		pointerEvents: 'none',
	});
	return measureEl;
}

/**
 * 定位「用户点开的是第几个块」。
 *
 * 主路径：把被点击的按钮所属的块容器映射回文档偏移（CM6 的 EditorView.posAtDOM，经 Editor.cm 拿到），
 * 再落到行号区间上 —— 精确，且不受核心「按内容相同复用 widget」的影响。
 * 兜底：按内容相等匹配；再不行回 0（宁可从头开始，也不要弹空白）。
 *
 * 代码块 chip 与图片嵌入的按钮都不在任何 `.cm-embed-block` 里，退回它所在的行（`.cm-line`）去定位：
 * chip 挂在开围栏那一行的末尾，图片的 `div.image-embed` 就是所在行的直接子节点，两者的行号都等于
 * 区间的起始行（图片区间是单行的）。这类锚点**只认精确命中**，对不上就返回 -1（弹窗不会开），
 * 避免「引用块里的围栏没有对应区间 → 翻出别的块」；对图片同样是想要的（宁可不开，也不翻出别的块）。
 *
 * 引用块的图标也不在任何 `.cm-embed-block` 里（它由 `scanner/quote.ts` 的 CM6 装饰器挂在
 * 「区间起始行」的**行尾**），走的同样是这条「按行精确匹配」的路：`actionEl` 是 widget 的容器，
 * `closest('.cm-line')` 命中的就是区间起始行，行号与 `region.startLine` 逐一相等。
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
 * 候选集来自**被点击按钮所在窗格的笔记文本**（`scanTextBlocks`，八类区间按类别开关过滤），不是 DOM：
 * Live Preview 只渲染视口附近的块，以 DOM 为准会让「总数」随滚动 / 光标 / 分屏变化。
 * 打开时算一次、提取一次，弹窗打开期间不再重采 —— 标题的总数与正文永远同源。
 */
export function createTextPopupSource(
	host: PopupSessionHost,
	actionEl: HTMLElement,
): { source: TextPopupSource; startIndex: number } {
	// 找不到按钮所属的窗格时退回活动视图：这是入口处可接受的近似（不再用 `document.body` 兜底 ——
	// 那会把别的窗格 / 别的笔记里的块也算进候选集，是「数量可能超过本笔记块数」的入口）。
	// 取 sourcePath 那类**解析基准**必须用 `containingMarkdownView` 的严格版，不能用这里的近似。
	const view =
		containingMarkdownView(host.app, actionEl) ??
		host.app.workspace.getActiveViewOfType(MarkdownView);
	const editor = view?.editor ?? null;
	const file = view?.file ?? host.app.workspace.getActiveFile();

	const { candidates, source } = buildPopupSession(
		host,
		() => actionEl.ownerDocument,
		editor,
		file,
	);
	const startIndex = editor ? locateStartIndex(editor, actionEl, candidates) : 0;

	return { source, startIndex };
}

/**
 * 命令入口：直接打开当前笔记里的第一个可放大区块。
 *
 * 返回 `false` 表示「这篇笔记里没有可打开的块」，由调用方（命令层）负责提示。
 *
 * 与点放大图标共用 `buildPopupSession`：**候选集必须同源**，否则会出现「命令说没有、
 * 方向键却能翻到」这类不一致。两者的差别只在起点固定为第一条。
 */
export function openFirstTextPopup(host: PopupSessionHost, editor: Editor): boolean {
	const file = host.app.workspace.getActiveFile();
	const { source } = buildPopupSession(host, () => activeDocument, editor, file);
	// 空块不弹窗：与点图标那条路径同一判据（`createActionEl` 里的 `open`）
	if (!source.read(0)) {
		source.dispose?.();
		return false;
	}
	new TextPopupModal(host.app, source, 0, host.settings).open();
	return true;
}

/**
 * 扫描笔记文本 → 候选集 + 内容来源；点放大图标与命令两条入口共用这一份实现。
 *
 * @param getDoc 取离屏宿主所在文档，**传函数而不是 Document**：只有手写 HTML 块需要离屏渲染，
 *   整篇没有可放大区块（或只有代码块 / Callout / 数学块）时一个游离节点都不建 —— 命令入口
 *   因此不必在无手写 HTML 的笔记里碰 `activeDocument`。
 */
function buildPopupSession(
	host: PopupSessionHost,
	getDoc: () => Document,
	editor: Editor | null,
	file: TFile | null,
): { candidates: PopupCandidate[]; source: TextPopupSource } {
	let measureEl: HTMLElement | null = null;
	// 移出可视区但保持「被布局」：innerText 依赖布局，display: none 会让它退化成 textContent
	const measure = (): HTMLElement => (measureEl ??= createOffscreenHost(getDoc()));

	const candidates: PopupCandidate[] = [];
	const entries: PopupEntry[] = [];
	const sourcePath = file?.path ?? '';
	for (const region of editor ? scanTextBlocks(editor.getValue()) : []) {
		if (!isKindEnabled(host.settings, region.kind)) continue;
		const candidate = createCandidate(region, host, measure, sourcePath);
		if (!candidate) continue;
		candidates.push(candidate);
		// 过滤元信息（V123）：类型 + 可搜索文本，与候选**同一个循环**里算，长度恒等于 size。
		// 两个数组必须同源：过滤筛的是「全集下标」，短一个就会错位到别的条目上。
		const type = entryTypeOf(candidate.region);
		entries.push({ type, text: entrySearchText(candidate.region, type) });
	}

	return {
		candidates,
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
			// 过滤用：每条候选的类型与可搜索文本；长度恒等于 size（缺了就按「不可过滤」处理）。
			entries,
			// V127：候选 → 源笔记行号。数据面只吐行号 —— 滚不滚、怎么滚是弹窗（与设置）的事，
			// 与 `read` 只吐内容、不关心渲染是同一条分层。
			blockStartLine(index: number): number | null {
				return candidates[index]?.region.startLine ?? null;
			},
			dispose(): void {
				measureEl?.remove();
			},
		},
	};
}

/**
 * 一个区间 → 一个候选；内容为空（点了会弹空白屏）时返回 null。
 *
 * `html` 走 1.0.3 的老路：离屏 `sanitizeHTMLToDom` 渲染后按「支持的标签」找目标元素；
 * `canvas` 另走一条：解析到文件后由 canvas.ts 渲染只读快照（见上面的分支）；
 * 其余六类是纯字符串处理，不需要 DOM，也不需要离屏宿主 —— `measure` 因此是惰性函数，
 * 只有真的遇到 html 区间才会建出那个游离节点。
 */
function createCandidate(
	region: TextBlockRegion,
	host: PopupSessionHost,
	measure: () => HTMLElement,
	sourcePath: string,
): PopupCandidate | null {
	if (region.kind === 'html') {
		// 与核心 widget 同样的渲染方式（公开 API sanitizeHTMLToDom），结构与编辑器里同源
		const holder = measure().createDiv();
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

	// Canvas 嵌入：不走 MarkdownRenderer（那只能拿到核心的 minimap 缩略图），改走「自渲染通道」——
	// 由 canvas.ts 把画布 JSON 画成一份只读快照。解析不到文件就不产候选（与 canMagnifyEmbed 同源，
	// 不留「有图标却点不开」的死图标）。
	if (region.kind === 'canvas') {
		const file = resolveCanvasFile(host.app, region.raw, sourcePath);
		if (!file) {
			console.warn(`[text-popup] Canvas 文件未找到：${region.raw}`);
			return null;
		}
		const plain = extractCanvasBody(region.raw);
		// 惰性解析 + 缓存：方向键来回翻同一条时不必重复 JSON.parse；DOM 每次重建
		// （缓存 DOM 会让上一次的 Component 卸载后留下失效的链接监听，得不偿失）。
		let doc: CanvasDocument | null | undefined;
		return {
			region,
			read: () => {
				if (!host.settings.renderRichText) return plain ? { plain, rich: '' } : null;
				return {
					plain,
					rich: '',
					render: async (el, component) => {
						doc ??= parseCanvasDocument(await host.app.vault.cachedRead(file));
						if (doc) await renderCanvasSnapshot(el, doc, { app: host.app, sourcePath: file.path, component });
					},
				};
			},
		};
	}

	// Excalidraw wiki embed：弹窗不直接渲染 Excalidraw 视图，而是改写为同名 PNG/SVG 图片
	// 嵌入交给 MarkdownRenderer。要求用户在 Excalidraw 插件里开启 Auto-export + filename sync。
	// 设置里默认关：未启用就直接返回 null，候选被丢弃（不弹空白窗）。
	if (region.kind === 'image' && isExcalidrawEmbed(region.raw)) {
		if (!host.settings.excalidrawImageFallback) return null;
		const resolved = resolveExcalidrawImage(
			host.app,
			region.raw,
			sourcePath,
			host.settings.excalidrawPreferredFormat,
		);
		if (!resolved) {
			console.warn(
				`[text-popup] Excalidraw 同名图片未找到，请确认 Auto-export 已开启并保持文件名同步：${region.raw}`,
			);
			return null;
		}
		const plain = extractImageBody(region.raw);
		return {
			region,
			read: () => {
				const rich = host.settings.renderRichText ? `![[${resolved}]]` : '';
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

