import { toCanvas } from 'html-to-image';
import type { App } from 'obsidian';

/**
 * 弹窗正文导出为图片的管线（V129，方案 [[Plan-20260926-231702]]，路线依据 [[Discuss-20260926-225756]]）。
 *
 * 分两层，与仓库既有的「纯函数层 + DOM 层」做法同源（参照 `canvas.ts`）：
 * - 纯函数层（文件名 / MIME / 夹取）：不碰 DOM，单测主战场；
 * - DOM 层（截图 / 剪贴板 / 落盘）：只在弹窗里跑，靠真机验证。
 *
 * 上下限与默认值放在**这里**而不是 `settings.ts`：`settings.ts` 会被 `scanner` → `modal` 传递依赖到
 * 本文件，反过来 import 就成环了。本文件只依赖 `obsidian` 与 `html-to-image`，是最底层。
 */

/** 导出格式。值与文件名后缀一致（`jpg` 而不是 `jpeg`）。 */
export type ExportFormat = 'png' | 'jpg';

/**
 * 导出范围（方案 [[Plan-20260927-074342]]，口径来自 [[Discuss-20260927-073439]]）：
 * - `content`：正文整块（`.text-popup-text`），长图、四周 32px 留白；
 * - `page`：屏幕上这一屏（`.text-popup-content`），不加留白、取当前滚动位置。
 */
export type ExportScope = 'content' | 'page';

export const EXPORT_QUALITY_MIN = 0.1;
export const EXPORT_QUALITY_MAX = 1;
export const EXPORT_QUALITY_STEP = 0.05;

export const EXPORT_SCALE_MIN = 1;
export const EXPORT_SCALE_MAX = 4;
export const EXPORT_SCALE_STEP = 0.5;

/** 0.92：`canvas.toBlob` 的常见默认档，体积与观感的常用平衡点。 */
export const DEFAULT_EXPORT_QUALITY = 0.92;
/** 2×：主流高分屏的像素密度，文字与线条在高倍下都不发糊。 */
export const DEFAULT_EXPORT_SCALE = 2;

/** 出图四周的留白（CSS px）。各倍率下换算成设备像素后再加，视觉留白保持一致。 */
export const EXPORT_PADDING = 32;

/** 文件名里不允许的字符（Windows / macOS 的公共禁区）。 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/g;

/** 笔记名为空时的兜底名（与 Obsidian 新建笔记的 `Untitled` 同口径）。 */
const UNTITLED = 'Untitled';

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** 复制到剪贴板恒用 PNG —— Chromium 的异步剪贴板写 `image/jpeg` 会被 `NotAllowedError` 拒。 */
export function resolveCopyMime(): 'image/png' {
	return 'image/png';
}

/** 下载走设置：JPG 映射到 `image/jpeg`（`canvas.toBlob` 只认这个 MIME），其余一律 PNG。 */
export function resolveDownloadMime(format: ExportFormat): 'image/png' | 'image/jpeg' {
	return format === 'jpg' ? 'image/jpeg' : 'image/png';
}

export function clampExportQuality(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EXPORT_QUALITY;
	return clamp(value, EXPORT_QUALITY_MIN, EXPORT_QUALITY_MAX);
}

export function clampExportScale(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EXPORT_SCALE;
	// 先夹再按步长取整：0.5 的步长下 1.3 会被拉到 1.5，值始终落在步长网格上
	const clamped = clamp(value, EXPORT_SCALE_MIN, EXPORT_SCALE_MAX);
	return Math.round(clamped / EXPORT_SCALE_STEP) * EXPORT_SCALE_STEP;
}

/**
 * `笔记名-YYYYMMDD-HHmmss[-范围].ext`：笔记名在前方便回看时溯源，时间戳保证连导不覆盖。
 * 非法字符替换成 `-`（不删：删掉会让两个不同的名字撞在一起），首尾空白与末尾的点一并去掉。
 *
 * `scope` 省略时与加它之前完全一致（既有的文件名用例因此保持通过）：两组菜单共用一份文件名
 * 逻辑，范围只是可选后缀。
 */
export function buildExportFileName(
	noteBasename: string,
	ext: string,
	at: Date,
	scope?: ExportScope,
): string {
	const base = (noteBasename ?? '').replace(ILLEGAL_NAME_CHARS, '-').trim().replace(/\.+$/, '');
	const name = base === '' ? UNTITLED : base;
	const stamp =
		`${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
		`-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
	const suffix = scope ? `-${scope}` : '';
	return `${name}-${stamp}${suffix}.${ext}`;
}

// ——————————————————————————————————————————————————————————————
// DOM 层
// ——————————————————————————————————————————————————————————————

export interface CaptureResult {
	canvas: HTMLCanvasElement;
	/**
	 * 正文里存在**已知拍不到**的内容（iframe 手写 HTML 块 / Canvas minimap）。
	 * 不阻断出图，交给调用方补一条提示（Discuss Q6「尽力而为」）。
	 */
	partial: boolean;
}

/** 已知拍不到的元素：iframe 是跨文档，`foreignObject` 类方案都进不去。 */
const UNCAPTURABLE_SELECTOR = 'iframe, .canvas-minimap';

/**
 * 把 `.text-popup-text` 整块拍成**未加留白**的 canvas —— 内容组与页面组共用的那一次 `toCanvas`
 * （方案 §2.4）。两条路径后面的差别只有「加留白」与「裁到页面盒」这一步。
 *
 * 为什么目标选它就能拿到「整块」：它是滚动容器 `.text-popup-content` 里带 `margin: auto` 的 flex 项，
 * 不被拉高也不被裁，`clientHeight` 就是内容自然高（styles.css:253-261）；而标题栏 / 控制条 / 过滤框
 * 分别是它的祖先或兄弟，天然不在图里。
 *
 * `style` 只作用于**克隆出来的根节点**，所以「忽略视图缩放与平移」不需要去动实时 DOM 的
 * `is-view-zoomed` / `--text-popup-view-scale`（`modal.ts`），零闪烁、也没有恢复失败的风险。
 *
 * 两个真机结论（见 Report-20260926-232317）：
 * - **不需要**为「拍不到块」做额外重排：html-to-image 把每个节点的**计算样式**内联进克隆，
 *   所以 `.is-rich img` 的 `max-height: 100cqh` 会以解析后的像素值（实测 833.328px）带走，
 *   容器查询上下文丢失这件事不成立（方案 §10 的 R2 已排除）。
 * - `onImageErrorHandler` 让**单张**图片抓不下来时留空继续出图，而不是整张导出失败。
 */
async function renderContentCanvas(
	node: HTMLElement,
	opts: { scale: number; backgroundColor: string },
): Promise<HTMLCanvasElement> {
	const scale = clampExportScale(opts.scale);
	return toCanvas(node, {
		pixelRatio: scale,
		backgroundColor: opts.backgroundColor,
		width: node.clientWidth,
		height: node.clientHeight,
		style: { transform: 'none', margin: '0' },
		// 外链图片抓不下来时让这一张留空、继续出图，而不是整张失败（Discuss Q6「尽力而为」）
		onImageErrorHandler: () => undefined,
	});
}

/** 内容组：正文整块 + 四周 32px 留白（长图）。 */
export async function capturePopupImage(
	node: HTMLElement,
	opts: { scale: number; backgroundColor: string },
): Promise<CaptureResult> {
	const scale = clampExportScale(opts.scale);
	const source = await renderContentCanvas(node, { scale, backgroundColor: opts.backgroundColor });
	return {
		canvas: withPadding(source, opts.backgroundColor, scale),
		partial: node.querySelector(UNCAPTURABLE_SELECTOR) !== null,
	};
}

/** 页面模式取哪一屏的几何。**全部是布局值**（CSS px），与设备像素倍率无关。 */
export interface PageCropInput {
	/** 内容左上角在页面盒**内容坐标系**里的位置（已含页面盒 padding），不受 transform / 滚动影响 */
	innerLeft: number;
	innerTop: number;
	scrollLeft: number;
	scrollTop: number;
}

export interface PageCrop {
	/** 源图（内容图，未加留白）左上角在页面盒坐标系里的位置；负值 = 内容还没顶到盒顶（居中情形） */
	sx: number;
	sy: number;
}

/**
 * 页面模式裁哪一刀（纯函数，方案 §2.2）。
 *
 * 四种边界落在同一条算子上，**不需要分支**：内容高于屏 → `sy = scrollTop - padding`（正是屏幕上那一屏）；
 * 内容矮于屏居中 → `sy < 0`（源矩形越界到图外，靠 `drawImage` 的比例裁剪语义 + 背景色补齐留白）。
 */
export function computePageCrop(input: PageCropInput): PageCrop {
	return { sx: input.scrollLeft - input.innerLeft, sy: input.scrollTop - input.innerTop };
}

/**
 * 读页面模式的滚动几何（方案 §2.2）。
 *
 * **不用 `getBoundingClientRect`**：后者会被 `.is-view-zoomed .text-popup-text` 上的 `transform`
 * 污染（styles.css:289-291），与「不跟随放大」的口径冲突；`offset*` 是布局值，不受 transform 影响，
 * 也不随滚动变化。两者 `offsetParent` 相同 —— `.text-popup-content` 全程 `position: static`，
 * `textEl` 是它的直接子节点（方案 R2）。
 */
export function resolvePageGeometry(
	scrollEl: HTMLElement,
	textEl: HTMLElement,
): PageCropInput {
	return {
		innerLeft: textEl.offsetLeft - scrollEl.offsetLeft - scrollEl.clientLeft,
		innerTop: textEl.offsetTop - scrollEl.offsetTop - scrollEl.clientTop,
		scrollLeft: scrollEl.scrollLeft,
		scrollTop: scrollEl.scrollTop,
	};
}

/**
 * 按页面盒裁一刀（方案 §2.3）。
 *
 * 页面组的出图尺寸**恒等于页面盒**（`clientWidth × clientHeight`，不含滚动条），与内容长短无关 ——
 * 内容组每张宽度可能不一样，页面组不会。
 */
export function cropToPage(
	source: HTMLCanvasElement,
	opts: {
		boxWidth: number;
		boxHeight: number;
		sx: number;
		sy: number;
		backgroundColor: string;
		scale: number;
	},
): HTMLCanvasElement {
	const scale = clampExportScale(opts.scale);
	const w = Math.max(1, Math.round(opts.boxWidth * scale));
	const h = Math.max(1, Math.round(opts.boxHeight * scale));
	// 用全局 `createEl` 而不是 `activeDocument.createEl`（理由见 `withPadding`）
	const canvas = createEl('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return source; // 拿不到 2d 上下文就退回未裁剪图，总比整张空白好
	ctx.fillStyle = opts.backgroundColor;
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(source, Math.round(opts.sx * scale), Math.round(opts.sy * scale), w, h, 0, 0, w, h);
	return canvas;
}

/**
 * 页面组：屏幕上这一屏（方案 §2）。
 *
 * 仍然是**拍 `textEl`** 这条已真机验证的路（图片内联、容器查询解析、单图失败兜底都在），
 * 只是不加留白，再按滚动几何裁到页面盒 —— 因为 `html-to-image` 是克隆 DOM，`scrollTop` 在克隆里
 * 一律归 0，直接拍 `scrollEl` 永远只能拿到从顶部开始的一屏（方案 §2.1）。
 */
export async function capturePopupPage(
	textEl: HTMLElement,
	scrollEl: HTMLElement,
	opts: { scale: number; backgroundColor: string },
): Promise<CaptureResult> {
	const scale = clampExportScale(opts.scale);
	const source = await renderContentCanvas(textEl, {
		scale,
		backgroundColor: opts.backgroundColor,
	});
	const { sx, sy } = computePageCrop(resolvePageGeometry(scrollEl, textEl));
	return {
		canvas: cropToPage(source, {
			boxWidth: scrollEl.clientWidth,
			boxHeight: scrollEl.clientHeight,
			sx,
			sy,
			backgroundColor: opts.backgroundColor,
			scale,
		}),
		partial: textEl.querySelector(UNCAPTURABLE_SELECTOR) !== null,
	};
}

/**
 * 四周加留白。
 *
 * 用**二次合成**而不是 `canvasWidth/canvasHeight` 选项 —— 后者是把画布拉大后把内容**拉伸**进去，
 * 这里要的是「内容 1:1 + 外面多一圈底色」。留白量按设备像素算（乘过倍率），各倍率下视觉一致。
 */
function withPadding(
	source: HTMLCanvasElement,
	backgroundColor: string,
	scale: number,
): HTMLCanvasElement {
	const pad = Math.round(EXPORT_PADDING * scale);
	// 用全局 `createEl` 而不是 `activeDocument.createEl`：后者是 Document 上的方法，
	// 真机实测它会 `appendChild` 到 document 上并抛 `HierarchyRequestError: Only one element on
	// document allowed`（Obsidian 1.13 / macOS，见 Report-20260926-232317）。
	const canvas = createEl('canvas');
	canvas.width = source.width + pad * 2;
	canvas.height = source.height + pad * 2;
	const ctx = canvas.getContext('2d');
	if (!ctx) return source; // 拿不到 2d 上下文就退回原图，总比整张空白好
	ctx.fillStyle = backgroundColor;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(source, pad, pad);
	return canvas;
}

/** `canvas.toBlob` 的 Promise 版；浏览器给不出 blob 时直接抛错，由调用方提示。 */
export function canvasToBlob(
	canvas: HTMLCanvasElement,
	mime: string,
	quality?: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
			mime,
			quality,
		);
	});
}

/** 恒写 PNG（见 `resolveCopyMime`）。失败时抛错，由调用方提示 —— 不静默。 */
export async function copyCanvasToClipboard(canvas: HTMLCanvasElement): Promise<void> {
	const mime = resolveCopyMime();
	const blob = await canvasToBlob(canvas, mime);
	await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
}

/**
 * 写进库内附件目录（不落系统下载文件夹，Discuss Q5 默认）。
 * 路径由 `getAvailablePathForAttachment` 生成：遵守用户的「附件默认位置」设置并自动去重。
 */
export async function saveCanvasToVault(
	app: App,
	canvas: HTMLCanvasElement,
	filename: string,
	opts: { format: ExportFormat; quality: number; sourcePath?: string },
): Promise<string> {
	const blob = await canvasToBlob(
		canvas,
		resolveDownloadMime(opts.format),
		clampExportQuality(opts.quality),
	);
	const buffer = await blob.arrayBuffer();
	const path = await app.fileManager.getAvailablePathForAttachment(filename, opts.sourcePath);
	await app.vault.createBinary(path, buffer);
	return path;
}
