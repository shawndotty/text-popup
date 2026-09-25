import { App, Component, MarkdownRenderer, Modal, Platform, setIcon } from 'obsidian';
import {
	availableTypes,
	formatPopupTitle,
	matchEntries,
	parseFilterInput,
	suggestTypes,
	suggestionContext,
} from './filter';
import type { PopupEntry, PopupEntryType } from './filter';
import { t } from './lang/helpers';
import {
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	FONT_SIZE_STEP,
	TextPopupSettings,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
} from './settings';

const DEFAULT_ZOOM = 1;

/**
 * mermaid 图「一屏装下」时允许的最大放大倍数：1 = 只缩不放，Infinity = 撑满一屏。
 * 取 2 的理由（实测三档对照见 Plan-20260919-171610 §3.2）：1 会让甘特图比笔记里还小，
 * Infinity 会把宽而扁的图放到 4 倍以上、文字夸张；2 让 6 张样本全部一屏装下且不超自然尺寸 2 倍。
 */
const MERMAID_MAX_FIT = 2;

/**
 * mermaid 缩放比的上下限（§3.5f）。理论区间是 0.375 ~ 18（字号 12~72、缩放 0.5~4），
 * 18 倍在 fit 基线上毫无使用价值，夹到 4 倍（已是 4 屏）即可。
 */
const MERMAID_SCALE_MIN = 0.25;
const MERMAID_SCALE_MAX = 4;

/**
 * Alt(Option)+Click 放大的倍数。取 2 与 reveal.js 的 zoom 插件默认值一致（见 Plan-20260920-154434 §1），
 * 硬编码而不做设置项：本插件已有的常量（MERMAID_MAX_FIT、DEFAULT_ZOOM）都是「硬编码 + 注释写明理由」，
 * 且加开关要动 settings.ts 的四处 + 校验用例，成本远高于功能本身。
 */
const CLICK_ZOOM_FACTOR = 2;

/**
 * 滚轮缩放的倍率上下限（照抄核心 handleWheelZoom 的 Math.clamp(zoomLevel, 1, 10)）：
 * 下限取 1 而不是 0.x —— 弹窗的 1× 就是「装下一屏」，再往下缩只有白边没有信息；
 * 上限 10 与核心一致（`Alt+Click` 的 2× 落在区间内，两者共用同一个 viewZoom 不会打架）。
 */
const VIEW_ZOOM_MIN = 1;
const VIEW_ZOOM_MAX = 10;

/**
 * 视图缩放过渡的时长（ms）。取 500 与 reveal.js zoom 插件的默认 `transitionDuration` 一致 ——
 * 「Alt+Click 放大」这套手感本来就以它为蓝本（见 Plan-20260920-154434 §1）。
 */
const VIEW_ZOOM_DURATION = 500;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** 保留一位小数，避免浮点累加出现 1.2000000000000002 这类值。 */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * 从一份 computed style 里挑出六级标题色变量（`--h1-color`…`--h6-color`），空值不收。
 *
 * 抽成纯函数是为了能被 `tests/modal.test.mjs` 直接喂假值钉住 —— 本仓库没有能跑真实样式的
 * DOM 环境（与 `tests/styles.test.mjs` 同一条理由）。取值与判空的逻辑见 `applyThemeHeadingColors`。
 */
export function headingColorVariables(style: {
	getPropertyValue(name: string): string;
}): [name: string, value: string][] {
	const variables: [name: string, value: string][] = [];
	for (let level = 1; level <= 6; level++) {
		const name = `--h${level}-color`;
		const value = style.getPropertyValue(name).trim();
		if (value) variables.push([name, value]);
	}
	return variables;
}

/**
 * Alt+Click 的目标倍数：未放大 → factor，已放大 → 回到 1。
 * 与 reveal.js zoom 插件的 `to()` / `out()` 同语义（已放大时再点即退出）。
 */
export function clickZoomTarget(current: number, factor: number): number {
	return current === 1 ? factor : 1;
}

/**
 * 滚轮增量 → 新的视图缩放倍数（未取整，照抄核心；它只写进 CSS 变量、不显示给用户）。
 *
 * 逐条对应核心 `handleWheelZoom`（app.js）：`DOM_DELTA_LINE` 折算 40px/行、`DOM_DELTA_PAGE`
 * 折算 800px/页（Electron 里实测 deltaMode 恒为 0，这两档留着是为了与核心逐字对齐）；
 * 步长 `-deltaY / 150`；macOS 上 `deltaY` **不是整数**（触控板/双指缩放）时步长翻倍。
 * 每格的实际幅度：鼠标滚轮一格 `deltaY = ±100`（整数，不翻倍）→ ±0.667；
 * 触控板一帧 `deltaY = ±3.5`（非整数，翻倍）→ ±0.0467，靠每秒几十帧连起来才平滑。
 */
export function wheelZoomTarget(
	current: number,
	deltaY: number,
	deltaMode: number,
	isMacOS: boolean,
): number {
	const pixels = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
	let step = -pixels / 150;
	if (isMacOS && !Number.isInteger(deltaY)) step *= 2;
	return clamp(current + step, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
}

/**
 * 鼠标位置 → 缩放层（`.text-popup-text`）内的坐标。
 *
 * 不用自己减内边距 / 算 `margin: auto` 的偏移：`transform-origin: 0 0` 时缩放后的包围盒
 * 左上角与缩放前重合，所以 `getBoundingClientRect()` 给的 left/top 就是元素的未缩放原点，
 * 除以当前倍数即还原到元素本地坐标（见 Plan-20260920-154434 §3.3）。
 */
export function elementPoint(
	clientX: number,
	clientY: number,
	rect: { left: number; top: number },
	scale: number,
): { x: number; y: number } {
	return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

/**
 * 让点击处停在屏幕原位的滚动补偿量：Δ = (s₂ − s₁) · p。
 *
 * 推导：元素内坐标 p 的点，屏幕横坐标 = `rect.left + s·p`，而 `rect.left` 只随滚动线性变化
 * （transform-origin 在 0 0，缩放不改包围盒左上角）—— 令缩放前后屏幕坐标相等即得上式。
 * 正值 = 内容被放大后要往右 / 往下多滚，才能让点击点留在原处。
 */
export function zoomScrollDelta(
	current: number,
	next: number,
	point: { x: number; y: number },
): { left: number; top: number } {
	const k = next - current;
	return { left: k * point.x, top: k * point.y };
}

/**
 * 画布（滚动容器可见区）的中心，屏幕坐标。
 *
 * 用 client 盒而不是 bounding box：`clientLeft/clientTop` 是边框内侧、`clientWidth/Height` 不含滚动条，
 * 「画布」指的正是这一块。入参收成结构化对象而不是 `HTMLElement`，是为了测试里能喂假值
 * （与 `headingColorVariables(style: { getPropertyValue })` 同一条理由）。
 */
export function viewportCenter(scroller: {
	getBoundingClientRect(): { left: number; top: number };
	clientLeft: number;
	clientTop: number;
	clientWidth: number;
	clientHeight: number;
}): { x: number; y: number } {
	const rect = scroller.getBoundingClientRect();
	return {
		x: rect.left + scroller.clientLeft + scroller.clientWidth / 2,
		y: rect.top + scroller.clientTop + scroller.clientHeight / 2,
	};
}

/**
 * 把点从屏幕位置 `from` 挪到 `to` 所需的滚动增量。
 *
 * 内容是往右 / 往下走，滚动量就要往反方向走，所以是 `from − to`。
 * 与 `zoomScrollDelta` 配合：前者负责「以点击处为锚」，后者再把它推到画布中心。
 */
export function scrollToMove(
	from: { x: number; y: number },
	to: { x: number; y: number },
): { left: number; top: number } {
	return { left: from.x - to.x, top: from.y - to.y };
}

/** 画布的滚动位置（`scrollLeft` / `scrollTop` 这一对总是成对出现）。 */
export interface ScrollOffset {
	left: number;
	top: number;
}

/** 没有平移的初始值（`viewPan` 的默认值，也是每帧写滚动量前要先归到的状态）。 */
const NO_PAN: ScrollOffset = { left: 0, top: 0 };

/**
 * 判「这一帧的滚动量放得下」的容差（CSS 像素）。
 *
 * read-back 的滚动量会被浏览器按设备像素对齐（本机 DPR 1.728 → 1 设备像素 ≈ 0.58px），
 * `scrollWidth` / `clientWidth` 又是整数，所以目标值与读回值差零点几像素是常态。不给容差的话分支会在
 * 边界上来回翻：两种分支的屏幕落位是同一个值（见 `resolveViewFrame`），画面不会变，但滚动量会莫名
 * 在 0 与目标之间跳，读日志的人会以为坏了。容差只有 1px，远小于真正需要补偿的量级（真机实测 164px）。
 */
const CLAMP_TOLERANCE = 1;

/** 一次视图缩放过渡的起止状态；中间帧由 `zoomTweenFrame` 插出来。 */
export interface ZoomTween {
	fromScale: number;
	toScale: number;
	fromScroll: ScrollOffset;
	toScroll: ScrollOffset;
}

/**
 * 缓动曲线：easeOutCubic（起步快、收尾慢）。点击后立刻有反馈、落点又不生硬，
 * 比线性或 ease-in 更贴合「放大到某处停住」这个动作。
 */
export function easeOutCubic(progress: number): number {
	const t = clamp(progress, 0, 1);
	return 1 - (1 - t) ** 3;
}

/**
 * 过渡的一帧：按进度 `progress`（0~1，未缓动）算出这一帧该写的 scale 与滚动位置。
 *
 * 为什么两者必须共用**同一条**缓动曲线、同一个进度：
 * 屏幕坐标 = 元素原点 − 滚动量 + scale · 元素本地坐标（transform-origin 在 0 0）。代入
 * scale(t) = s₁ + e·(s₂−s₁)、scroll(t) = L₁ + e·(L₂−L₁) 后，被锚定的那一点在屏幕上正好是
 * `点击处 + e · (画布中心 − 点击处)` —— 也就是沿直线从原位置滑到画布中心。任何一项自己走
 * 另一条时间线（例如滚动瞬间到位、scale 慢慢变），中途都会看到内容先跳一下再缩放。
 *
 * 越界的 progress 直接夹到 [0, 1]：rAF 的最后一帧可能略微超时，不夹会写过头再回弹。
 */
export function zoomTweenFrame(
	tween: ZoomTween,
	progress: number,
): { scale: number; scroll: ScrollOffset } {
	const e = easeOutCubic(progress);
	return {
		scale: tween.fromScale + (tween.toScale - tween.fromScale) * e,
		scroll: {
			left: tween.fromScroll.left + (tween.toScroll.left - tween.fromScroll.left) * e,
			top: tween.fromScroll.top + (tween.toScroll.top - tween.fromScroll.top) * e,
		},
	};
}

/**
 * 把目标滚动量夹进「该倍数下真正可达的范围」。
 *
 * 目标（把点击处推到画布中心）经常超出可达范围：真机实测内容块 1077 宽、画布 1481，点击落在画布
 * 左侧时算出来的目标横向是 1191，而 2× 的上限只有 875。不夹的话终点落在范围外，收尾那一帧会被
 * 解算成「滚动写 0、整段交给平移」，而收尾又要按终态提交 —— 内容在动画末尾跳一大段（875px 量级）。
 * 夹到上限之后终点一定可达，收尾帧走「放得下」分支、平移自然收到 0。屏幕上的终点与夹之前**完全
 * 相同**（浏览器本来就会把它夹到同一个值），变的只是中途那几帧（见 resolveViewFrame）。
 */
export function clampScroll(target: ScrollOffset, limit: ScrollOffset): ScrollOffset {
	return { left: clamp(target.left, 0, limit.left), top: clamp(target.top, 0, limit.top) };
}

/**
 * 一帧的落位：把插值算出的滚动量落到浏览器真正接受得了的表示上，返回这一帧要写的滚动量与要由
 * transform 平移承担的差额。
 *
 * 为什么需要它：滚动量是**会被夹的量**，一旦被夹，`zoomTweenFrame` 那条直线就断掉，内容先被钉住、
 * 再随 scale 反向漂回去。两个方向都会撞上它，只是成因不同：
 *   - Zoom out：可滚区间随缩小塌到 0（真机实测横向甩回 101px，见 Report-20260920-202610 §3）。
 *   - Zoom in：可滚区间要等放大到 scale≈1.19 才出现（内容 1077 宽、画布 1481，1× 时横向根本滚不动），
 *     于是前几帧的滚动被钉在 0，内容先朝**反方向**漂出 155px、再被追回来（真机实测，见
 *     Report-20260920-223435 §3）。
 * 所以被夹掉的那一段一律交给不受滚动上限约束的 `translate`：屏幕坐标 = 原点 − 滚动 + 平移 +
 * scale × 本地坐标，两种分支都等于 `原点 − 目标`，边界处连续、不会跳。
 *
 * 这里有个反直觉但必须遵守的约束：**平移会让内容块末端内缩、可滚区间跟着变小**，浏览器会把刚写进去
 * 的滚动量**再夹一次**（实测写 875 / 平移到 −200 后读到 674.8）。于是「滚动担一部分、平移补一部分」
 * 是解不出来的，不动点只有两个：
 *   ① 放得下（读回来就等于目标）→ 滚动全担；
 *   ② 放不下 → 滚动写 0（0 永远合法、不会再被夹），整段交给平移。
 *
 * 前提是**目标本身可达** —— 不可达时收尾那一帧必然落在分支②、平移收不回来，兜底只能靠收尾帧按
 * 解出的值提交（见 animateViewZoom），而那会留下永久位移。所以调用方要先用 `clampScroll` 把目标夹进
 * 该倍数下真正可达的范围（`reachableScroll` 量出来的那个值）。
 *
 * `carry` 是上一段过渡还没收回的平移：它已经在屏幕上生效，中途被打断时不能瞬间抹掉，
 * 所以按进度收回；过渡结束（progress = 1）时它必须为 0，否则会留下永久位移。
 * `eased` 要传**缓动后**的进度（与 scale / 滚动同一条曲线）：收回的节奏若与缩放对不上，
 * 打断后内容会先反向漂一下 —— 收回走原始进度、缩放走 easeOutCubic 时实测甩了 22px。
 */
export function resolveViewFrame(
	desired: ScrollOffset,
	accepted: ScrollOffset,
	carry: ScrollOffset,
	eased: number,
): { scroll: ScrollOffset; pan: ScrollOffset } {
	const rest = 1 - clamp(eased, 0, 1);
	const residual = { left: carry.left * rest, top: carry.top * rest };
	const axis = (target: number, got: number, left: number) =>
		got >= target - CLAMP_TOLERANCE ? { scroll: target, pan: left } : { scroll: 0, pan: left - target };
	const x = axis(desired.left, accepted.left, residual.left);
	const y = axis(desired.top, accepted.top, residual.top);
	return { scroll: { left: x.scroll, top: y.scroll }, pan: { left: x.pan, top: y.pan } };
}

/**
 * 单帧的落位：把「这一帧需要的总位移」拆成滚动与平移两份。
 *
 * 推导：屏幕坐标 = 元素原点 − 滚动量 + 平移 + scale · 元素本地坐标（transform-origin 在 0 0）。
 * 要让锚点在缩放前后停在同一处，`平移 − 滚动` 这一对必须恒等于 `carry − desired`，其中
 * `desired = 当前滚动 + 缩放补偿`、`carry = 上一帧留下的平移`。移项后就是这里的入参
 * `need = desired − carry`：**这一帧从「内容自然位」算起一共要挪多少**。
 *
 * 于是只有两种合法分法（与 `resolveViewFrame` 同源，那里是过渡版）：
 *   ① 放得下（`0 ≤ need ≤ 该倍数下的可达上限`）→ 滚动全担、平移清零；
 *   ② 放不下 → 滚动写 0（0 永远是合法值、不会再被夹），整段交给平移。
 * 「滚动担一部分、平移补一部分」解不出来：平移会让内容块末端内缩、可滚区间跟着变小，
 * 浏览器会把刚写进去的滚动量再夹一次（实测写 875 / 平移到 −200 后读到 674.8）。
 *
 * 为什么必须优先让**滚动**担：滚动是用户可以自己滚回来的量（滚到 0 就能看到内容左上角），
 * 而平移一旦写进去，内容被推到滚动原点之外的那一段就再也滚不到了。所以只在滚动真的放不下时
 * 才动用平移 —— 这是「缩放抖动」修复（`need` 的引入）要守住的那条边界。
 *
 * 与 `resolveViewFrame` 的分工：那里是过渡的中间帧，靠「写完再读回」问浏览器夹了多少，残留还要
 * 按缓动进度收回；这里是单帧，上限由调用方先量好（`reachableScroll`）再传进来，一次定案。
 */
export function settleZoomFrame(
	need: ScrollOffset,
	limit: ScrollOffset,
): { scroll: ScrollOffset; pan: ScrollOffset } {
	const axis = (value: number, max: number) =>
		value >= 0 && value <= max ? { scroll: value, pan: 0 } : { scroll: 0, pan: -value };
	const x = axis(need.left, limit.left);
	const y = axis(need.top, limit.top);
	return { scroll: { left: x.scroll, top: y.scroll }, pan: { left: x.pan, top: y.pan } };
}

/**
 * 移动端左右滑动切换条目的判据。
 *
 * 抽成纯函数是为了能被 `tests/modal.test.mjs` 直接喂假值钉住 —— 与本文件其它
 * 几何 / 判据函数（clickZoomTarget、wheelZoomTarget…）同一条理由：没有能跑
 * 真实手势的 DOM 环境，只能把判据本身钉住，真机 eval 验收落点。
 *
 * 返回 -1 = 切到上一条（手指往右滑，与 ArrowLeft 同义）、
 * +1 = 切到下一条（手指往左滑，与 ArrowRight 同义）、0 = 不触发。
 *
 * 三道判据：
 * - 距离 ≥ 50px：太短会与点击 / 轻微抖动误触。移动端浏览器自身的滑动手势阈值
 *   通常在 10~30px，50px 比它高一档才能压住误触。
 * - 横向占优比 ≥ 2（|dx| ≥ 2·|dy|）：内容区纵向滚动是常态，比例太低会把
 *   斜向滑动也吞掉；2 这条线能让「明显横向」与「明显纵向 / 斜向」分开。
 * - 横向有可滚区间时只在边界触发：放大后内容比画布宽时用户可以横向滚动浏览，
 *   不能在中途抢手势；只有滚到起点（左边界）再往右滑、或滚到终点（右边界）再
 *   往左滑才算「想切条目」。无横向滚动区间时（= 内容比画布窄）不受此约束。
 */
const SWIPE_DISTANCE_THRESHOLD = 50;
const SWIPE_AXIS_RATIO = 2;

export function swipeDirection(
	start: { x: number; y: number; scrollLeft: number; maxScroll: number },
	end: { x: number; y: number },
): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (Math.abs(dx) < SWIPE_DISTANCE_THRESHOLD) return 0;
	if (Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy)) return 0;
	// 有横向可滚区间时只在边界触发（避免抢走放大后的横向平移）
	if (start.maxScroll > 0) {
		if (dx > 0 && start.scrollLeft > 0) return 0; // 右滑但不在左边界
		if (dx < 0 && start.scrollLeft < start.maxScroll) return 0; // 左滑但不在右边界
	}
	return dx > 0 ? -1 : 1;
}

/**
 * 系统开了「减少动态效果」时不做过渡。动画纯属观感，用户显式关掉就该直接给结果；
 * 这条分支同时也是「瞬时跳变」这套旧行为的回归路径。
 */
function prefersReducedMotion(): boolean {
	return activeWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 单个条目的内容。 */
export interface TextPopupBody {
	/** 纯文本内容（extractText），回退路径使用。 */
	plain: string;
	/** 富文本输入（extractRichSource），可能为空字符串。 */
	rich: string;
	/**
	 * 自渲染通道（目前只有 Canvas 快照）：拿到正文容器与一个可用的 Component，自己产出 DOM。
	 * 存在时**优先于 `rich`**；抛错或没画出东西时由 `renderBody` 回退到 `plain`。
	 *
	 * 用可选方法而不是「字符串 | 函数」联合：另外七类区块的候选一行都不用改，
	 * `TextPopupSource.read()` 的返回类型也不变。
	 */
	render?(el: HTMLElement, component: Component): Promise<void> | void;
}

/**
 * 一次弹窗会话的内容来源：同一笔记内全部被标记的块，按文档顺序。
 *
 * 由 scanner 在点击时组装；弹窗只按索引读，不认识 DOM，也不关心内容是怎么提取的。
 */
export interface TextPopupSource {
	/** 候选条目总数。 */
	readonly size: number;
	/** 标题栏显示的笔记名。 */
	readonly sourceName: string;
	/** 链接 / 嵌入的解析基准：笔记完整路径（TFile.path），不能用 basename。 */
	readonly sourcePath: string;
	/** 惰性提取第 index 条的内容；越界或提取为空时返回 null。 */
	read(index: number): TextPopupBody | null;
	/**
	 * 过滤用元信息：每条候选的类型与可搜索文本，长度恒等于 `size`（V123）。
	 *
	 * **可选**：缺省（或长度与 `size` 对不上）时弹窗按「不可过滤」处理 —— 不注册 `/`，
	 * 计数与导航完全保持今天的行为。这样测试桩与自造 source 一行都不用改。
	 */
	entries?: readonly PopupEntry[];
	/** 会话结束时的清理（例如移除离屏宿主）；实现方可选。 */
	dispose?(): void;
}

/**
 * 文字放大弹窗。
 *
 * - 用 Obsidian 自带的 Modal，免费获得 Esc 关闭、点击遮罩关闭、关闭按钮与焦点陷阱。
 * - 尺寸铺满 Obsidian 应用窗口（与内置图片 lightbox 同一思路），便于演示时凸显重点。
 * - 标题栏显示来源笔记名，便于溯源；同一笔记有多个被标记块时附带「当前 / 总数」序号。
 * - 用 ← / → 在同一个笔记的全部被标记块之间切换，环绕规则与内置图片 lightbox 一致。
 * - 底部控制条提供字号与缩放；只影响本次弹窗，不写回设置。
 * - `Alt(Option)+Click` 以点击处为锚放大、并把它推到画布中心（再点还原），放大后按住空格可拖拽平移。
 *   放大 / 还原都走一段 500ms 的过渡（缓动 + 逐帧插值），不是瞬间跳变，见 animateViewZoom。
 * - `Ctrl` / `Command` + 滚轮（触控板双指缩放）以指针为锚缩放视图（1×~10×，瞬时、不带走过渡），
 *   算式照抄内置图片查看器的 handleWheelZoom，见 onWheel / zoomAtPoint。锚点补偿优先交给滚动
 *   （用户能自己滚回来），只有滚动放不下时才动用平移，见 settleZoomFrame。
 * - 内容默认交给 MarkdownRenderer 渲染 HTML 与 Markdown，失败时回退纯文本。
 * - Canvas 嵌入例外：它走 `TextPopupBody.render` 这条**自渲染通道**（见 canvas.ts），
 *   产出的是一份只读快照 DOM，不经过 MarkdownRenderer（否则只能拿到核心的 minimap 缩略图）。
 */
export class TextPopupModal extends Modal {
	/** MarkdownRenderer 要求传入真实 Component，并在关闭时卸载，避免嵌入内容的事件监听泄漏。 */
	private component = new Component();
	private fontSize: number;
	private zoom = DEFAULT_ZOOM;
	/** 当前显示的是候选里的第几条。 */
	private index: number;
	private scrollEl!: HTMLElement;
	/** 当前屏的正文容器；每次切换都换新（见 renderBody 的注释）。 */
	private textEl: HTMLElement | null = null;
	/** 渲染令牌：连按方向键时用它丢弃过期的渲染。 */
	private renderToken = 0;
	private fontSizeValueEl: HTMLElement | null = null;
	private zoomValueEl: HTMLElement | null = null;
	/** 盯着 mermaid 的 svg 与 Canvas 快照被异步插进来（时序见 fitScaledContent）；onClose 里断开。 */
	private fitObserver: MutationObserver | null = null;
	/** 弹窗铺满窗口，窗口尺寸变了 fit 就过期；存成字段才能在 onClose 里解绑。 */
	private resizeHandler = (): void => this.fitScaledContent();
	/**
	 * 视图缩放（Alt+Click 放大镜），与字号无关的纯视觉放大，1 = 原始大小。
	 * 与字号 / 缩放是相乘关系：字号仍然照旧重排，这一层是叠在上面的 transform。
	 */
	private viewZoom = 1;
	/**
	 * 进入放大前的滚动位置。再点一下还原时写回去 —— 「刚才看到哪儿」比「放大到哪儿」更重要，
	 * 而放大期间浏览器会把 scrollTop 夹在新范围内，不写回就回不到原位。
	 */
	private viewZoomReturn: ScrollOffset | null = null;
	/**
	 * 正在跑的视图缩放过渡；null = 没有过渡。
	 * 任何「立刻要一个确定状态」的路径（切换条目、恢复默认、开始拖拽、关窗）都要先取消它，
	 * 否则后续几帧里插值会把刚写好的状态覆盖掉。窗口一起存：弹窗被拖到 pop-out 窗口后
	 * `activeWindow` 会变，取消得回到当初发出那一帧的窗口上去取消。
	 */
	private viewZoomFrame: { win: Window; id: number } | null = null;
	/**
	 * 平移补偿（屏幕像素）：过渡期间浏览器把滚动量夹掉的那部分，改由 transform 的 translate 顶上，
	 * 让内容在屏幕上的位移始终等于插值给的那条线。非过渡期间它只在缩放态下可能非 0（1× 时恒为 0），
	 * 份额与由来见 `resolveViewFrame` / `animateViewZoom`。
	 */
	private viewPan: ScrollOffset = NO_PAN;
	/** 空格是否按住（平移待命）。 */
	private spaceDown = false;
	/** 正在拖拽平移时的起点；非空 = 正在拖（也用来给文档级 pointermove 做门禁）。 */
	private panOrigin: {
		pointerId: number;
		x: number;
		y: number;
		left: number;
		top: number;
	} | null = null;
	/**
	 * 移动端滑动手势的起点（含当时的横向滚动位置与可达上限）；null = 没在追踪。
	 *
	 * 只记 touchstart 那一刻的 scrollLeft / maxScroll：touchmove 期间浏览器自己会
	 * 横向滚动（放大后内容比画布宽时），用结束时刻的值会误判「已在边界」。
	 */
	private touchStart: {
		x: number;
		y: number;
		scrollLeft: number;
		maxScroll: number;
	} | null = null;

	// —— 过滤模式（V123，方案 [[Plan-20260925-072735]]）——
	/** 过滤框是否展开。它是唯一的**可视**状态，其余（`matches` / 计数 / 导航范围）都是派生量。 */
	private filterOpen = false;
	/** 输入框原文；关框后仍保留 —— 这就是卡片要的「退出过滤后条件保留」。 */
	private filterValue = '';
	/** 命中项在**全集**里的下标；空数组 = 没有过滤（导航与计数都按全量走）。 */
	private matches: number[] = [];
	/** 进入过滤态那一刻的 index：零命中时退回它（卡片 A6）。 */
	private filterAnchor = 0;
	private filterInputEl: HTMLInputElement | null = null;
	private suggestEl: HTMLElement | null = null;
	private suggestItems: PopupEntryType[] = [];
	/** 高亮项下标；-1 = 没有高亮（列表为空时）。 */
	private suggestIndex = -1;

	constructor(
		app: App,
		private source: TextPopupSource,
		startIndex: number,
		private settings: TextPopupSettings,
	) {
		super(app);
		this.fontSize = settings.popupFontSize;
		this.index = startIndex;
	}

	/**
	 * Alt+Click 的按下态压掉（不压的话会开始拖选文字）。
	 *
	 * 真正的开关在 `onClick` 里，不在 mousedown 上：正文里的 `[[链接]]` 跳转由核心的 `click`
	 * 处理器负责生效，只在 mousedown 上拦挡不住它。
	 */
	private onMouseDown = (evt: MouseEvent): void => {
		if (evt.altKey && evt.button === 0) evt.preventDefault();
	};

	/** 只认 Alt(Option) + 左键。监听挂在 `.text-popup-content` 上，所以控制条的 Alt+Click 不会被误伤。 */
	private onClick = (evt: MouseEvent): void => {
		if (!evt.altKey || evt.button !== 0) return;
		// preventDefault 压掉链接跳转 / 其它默认行为，stopPropagation 拦住冒泡到核心的点击处理器
		evt.preventDefault();
		evt.stopPropagation();
		this.toggleClickZoom(evt.clientX, evt.clientY);
	};

	/**
	 * Ctrl / Command + 滚轮：以指针为锚缩放视图（= 内置图片查看器的手感）。
	 *
	 * 只认带修饰键的 wheel：不按修饰键的那种是**原生滚动** —— 放大之后它正好当平移用
	 * （内容区的可滚区间会随内容一起长出来，实测 1.6× 时 scrollHeight 833 → 1189），
	 * 与核心 else 分支的「滚轮平移」同效，所以这里一行都不用写。
	 *
	 * `preventDefault` 必须写：核心在图片查看器里就是无条件压掉默认动作，且用 {passive:!1}
	 * 注册（不写的话浏览器可能把 wheel 当被动监听，压不掉 Electron 的默认 Ctrl+滚轮缩放）。
	 */
	private onWheel = (evt: WheelEvent): void => {
		if (!evt.ctrlKey && !evt.metaKey) return;
		evt.preventDefault();
		const next = wheelZoomTarget(this.viewZoom, evt.deltaY, evt.deltaMode, Platform.isMacOS);
		if (next !== this.viewZoom) this.zoomAtPoint(evt.clientX, evt.clientY, next);
	};

	/**
	 * 空格按下：进入平移待命。
	 *
	 * 用**文档级** keydown/keyup 而不是 Modal 的 scope —— scope 只有 keydown，
	 * 收不到「松开空格」，而平移必须在松手时结束。
	 *
	 * ⚠️ 必须注册在 **capture 阶段**：控制条按钮自己也有 keydown（Enter = 激活按钮），而弹窗一打开
	 * 焦点就被核心送到第一个按钮上（见 Plan-20260920-161511 §3.1 证据①）—— 冒泡阶段注册时按钮先手，
	 * 「按住空格」会变成「反复点那个按钮」（字号 / 缩放一路变、内容重排、画布跳动），平移根本进不去。
	 * capture 阶段先手 + stopPropagation，按钮再也看不到空格；`repeat` 必须一并吞掉。
	 */
	private onKeyDown = (evt: KeyboardEvent): void => {
		// 过滤态下空格是**输入空格**，不是平移待命（Plan §6 矩阵，真机 K7）
		if (this.filterOpen) return;
		if (evt.key !== ' ' || evt.defaultPrevented) return;
		// 只收自己弹窗里的空格：弹窗开着时用户又开了别的 Modal（快速切换、命令面板…），
		// 那里面的输入框要能正常打空格。
		//
		// 判据是「不属于**别的** Modal 容器」，而不是「在 `modalEl` 之内」：在弹窗正文里点一下
		// （非 `Alt` 的普通点击）核心会把焦点退回 `<body>`，此时「在 modalEl 之内」恒为假、
		// 空格平移会**整个失效**。实测见 Report-20260920-182816 §4。
		const holder = evt.target instanceof Element ? evt.target.closest('.modal-container') : null;
		if (holder && !holder.contains(this.modalEl)) return;
		evt.preventDefault(); // 压掉空格的翻页滚动
		evt.stopPropagation(); // 控制条按钮 / 核心的 keydown 都收不到
		if (evt.repeat) return; // 自动重复只吞，不重复进入待命
		this.spaceDown = true;
		this.scrollEl.addClass('is-pan-ready');
	};

	private onKeyUp = (evt: KeyboardEvent): void => {
		if (evt.key !== ' ') return;
		this.endPanReady();
	};

	/** 按住空格时切窗口，keyup 永远不会来 —— 靠窗口失焦收口。 */
	private onWindowBlur = (): void => this.endPanReady();

	private onPointerDown = (evt: PointerEvent): void => {
		if (!this.spaceDown || evt.button !== 0) return;
		// 拖拽要自己写滚动位置，与过渡的插值会互相覆盖 —— 抢到控制权时先把过渡停掉
		this.cancelViewZoom();
		this.panOrigin = {
			pointerId: evt.pointerId,
			x: evt.clientX,
			y: evt.clientY,
			left: this.scrollEl.scrollLeft,
			top: this.scrollEl.scrollTop,
		};
		this.scrollEl.addClass('is-panning');
		evt.preventDefault(); // 压掉拖选文字与原生拖拽
	};

	private onPointerMove = (evt: PointerEvent): void => {
		const origin = this.panOrigin;
		if (!origin || origin.pointerId !== evt.pointerId) return;
		// 鼠标往哪边拖，内容就往哪边走 → 滚动位置往反方向走
		this.scrollEl.scrollLeft = origin.left - (evt.clientX - origin.x);
		this.scrollEl.scrollTop = origin.top - (evt.clientY - origin.y);
	};

	private onPointerUp = (evt: PointerEvent): void => {
		if (this.panOrigin?.pointerId !== evt.pointerId) return;
		this.endPan();
	};

	private onPointerCancel = (evt: PointerEvent): void => {
		if (this.panOrigin?.pointerId !== evt.pointerId) return;
		this.endPan();
	};

	/**
	 * 移动端 touchstart：记录起点与当时的横向滚动状态。
	 *
	 * 只认单指（多指 = 双指缩放之类，不参与滑动切换）。passive: true 不阻止
	 * 浏览器的原生滚动 —— 切换的判据全在 touchend 上，touchmove 期间让
	 * 浏览器自己滚，不打断原生手感。
	 */
	private onTouchStart = (evt: TouchEvent): void => {
		if (evt.touches.length !== 1) return;
		const touch = evt.touches[0];
		if (!touch) return;
		this.touchStart = {
			x: touch.clientX,
			y: touch.clientY,
			scrollLeft: this.scrollEl.scrollLeft,
			maxScroll: this.scrollEl.scrollWidth - this.scrollEl.clientWidth,
		};
	};

	/**
	 * 移动端 touchend：按 swipeDirection 的判据决定切不切换、往哪边切。
	 *
	 * 不 preventDefault：touchend 时手势已经结束，浏览器没有默认动作要压。
	 * direction = 0 时什么都不做（短触、纵向滚动、斜向滑动都不触发切换）。
	 */
	private onTouchEnd = (evt: TouchEvent): void => {
		const start = this.touchStart;
		if (!start) return;
		this.touchStart = null;
		const touch = evt.changedTouches[0];
		if (!touch) return;
		const direction = swipeDirection(start, { x: touch.clientX, y: touch.clientY });
		if (direction !== 0) this.step(direction);
	};

	onOpen(): void {
		this.modalEl.addClass('mod-text-popup');
		this.updateTitle();

		// 空字符串表示跟随主题：此时不设变量，交给 styles.css 的默认值。
		const background = this.settings.popupBackgroundColor;
		if (background) this.modalEl.style.setProperty('--text-popup-bg', background);
		const foreground = this.settings.popupTextColor;
		if (foreground) this.modalEl.style.setProperty('--text-popup-fg', foreground);
		// 跟随主题时连主题的六级标题色一起搬进来；填了自定义色就不搬 —— 那是用户在显式覆盖
		// 弹窗文字色，标题跟着继承这个颜色（既有行为）。两者取舍见 applyThemeHeadingColors。
		if (!foreground) this.applyThemeHeadingColors();

		// 必须在 render 之前 load：渲染出的子组件会挂在它下面。
		this.component.load();

		// 方向键交给 Modal 自带的 scope：核心在 open() 里已把它压进键盘栈，关闭时自动弹出。
		// modifiers 传 null = 不限修饰键，与内置图片 lightbox 的行为一致。
		// 过滤态下 ← → 要归光标（输入框里移动光标），所以这里先放行 —— 返回 true = 不吞这个键，
		// 交给浏览器把事件送到聚焦的输入框上（Plan §6 键盘矩阵）。
		this.scope.register(null, 'ArrowLeft', () => (this.filterOpen ? true : this.step(-1)));
		this.scope.register(null, 'ArrowRight', () => (this.filterOpen ? true : this.step(1)));

		// 过滤模式（V123）：`/` 唤起、`Esc` 收起。
		// `/` 一期只在桌面注册：移动端没有物理键盘，软键盘会遮掉半屏（Discuss Q1）。
		if (!Platform.isMobile) {
			this.scope.register(null, '/', () => (this.filterOpen ? true : this.openFilter()));
		}
		// `Esc` **不走 scope**：真机实测（K4）注册在 `onOpen` 的 scope 抢不过核心的「Esc 关弹窗」
		// ——按下去弹窗直接关了，过滤框根本没机会收；改用文档级 capture 也**不够**（核心的 keymap
		// 同样是 document 级 capture，且注册得更早，同相同时按注册顺序跑）。所以挂到 **window**
		// 的 capture 上：事件路径是 window → document → …，window 一定先手（方案 §10 R1 的回退路径）。
		activeWindow.addEventListener('keydown', this.onEscapeCapture, true);

		// 文字外面再包一层，方便用 margin: auto 在满屏窗口里居中：
		// 内容短时居中显示，内容长时仍可从头滚动。
		this.scrollEl = this.contentEl.createDiv({ cls: 'text-popup-content' });

		// mermaid 的 svg 是异步插进来的（实测比正文容器晚约 5ms、在另一个 task 里，见 fitScaledContent），
		// Canvas 快照的节点盒同理（`MarkdownRenderer` 是异步的）。所以除了渲染后主动算一次，
		// 还要盯着新插入的内容补算。
		this.fitObserver = new MutationObserver(() => this.fitScaledContent());
		// 只监听 childList：fitScaledContent 写的是 CSS 变量（属性变更），不会自触发成死循环。
		this.fitObserver.observe(this.scrollEl, { childList: true, subtree: true });
		// 弹窗铺满窗口，窗口尺寸变了 fit 就过期
		activeWindow.addEventListener('resize', this.resizeHandler);

		// 视图缩放（Alt+Click）与空格平移：都只挂正文区，控制条 / 标题栏不受影响。
		this.scrollEl.addEventListener('mousedown', this.onMouseDown);
		this.scrollEl.addEventListener('click', this.onClick);
		// passive: false 才能 preventDefault 掉 Electron 默认的整界面缩放（见 onWheel）
		this.scrollEl.addEventListener('wheel', this.onWheel, { passive: false });
		this.scrollEl.addEventListener('pointerdown', this.onPointerDown);
		// 拖拽要在鼠标移出弹窗 / 移出窗口后继续收事件 → 移动与结束挂文档级。
		// 不调 setPointerCapture：它是给「鼠标移出窗口后还要继续收事件」用的，而鼠标按住时
		// 浏览器本来就会把事件继续投递给文档；且合成事件下它会抛 NotFoundError（见 Plan §3.4）。
		activeDocument.addEventListener('pointermove', this.onPointerMove);
		activeDocument.addEventListener('pointerup', this.onPointerUp);
		activeDocument.addEventListener('pointercancel', this.onPointerCancel);
		// 空格平移必须赶在控制条按钮 / 核心之前拿到事件，所以注册在 capture 阶段（解绑也要带 true）。
		activeDocument.addEventListener('keydown', this.onKeyDown, true);
		activeDocument.addEventListener('keyup', this.onKeyUp);
		activeWindow.addEventListener('blur', this.onWindowBlur);

		// 移动端：左右滑动切换条目（与方向键同义）。判据见 swipeDirection。
		// 只在移动端注册：桌面端有方向键，touch 事件在无触屏的桌面也永不触发，
		// 但按平台分支注册与本文件其它 Platform.isMobile 分支（quote.ts / scanner）同源。
		if (Platform.isMobile) {
			// passive: true —— 不阻止原生滚动，touchmove 期间让浏览器自己滚
			this.scrollEl.addEventListener('touchstart', this.onTouchStart, { passive: true });
			this.scrollEl.addEventListener('touchend', this.onTouchEnd, { passive: true });
		}

		this.buildControls(this.contentEl);
		// 过滤框在控制条**之后**建：两者都是绝对定位的兄弟，后插入的天然压在上面（z-index 另给 3）
		this.buildFilter(this.contentEl);
		this.updateSize();

		this.show(this.index);
	}

	onClose(): void {
		this.component.unload();
		// 视图缩放 / 平移的监听同样属于「弹窗存续期间」的资源，逐一解绑
		this.scrollEl.removeEventListener('mousedown', this.onMouseDown);
		this.scrollEl.removeEventListener('click', this.onClick);
		// removeEventListener 不比较 passive，只比较 capture，所以解绑不用带配置对象
		this.scrollEl.removeEventListener('wheel', this.onWheel);
		this.scrollEl.removeEventListener('pointerdown', this.onPointerDown);
		activeDocument.removeEventListener('pointermove', this.onPointerMove);
		activeDocument.removeEventListener('pointerup', this.onPointerUp);
		activeDocument.removeEventListener('pointercancel', this.onPointerCancel);
		// capture 标记必须与 onOpen 里一致，否则这个监听解绑不掉
		activeDocument.removeEventListener('keydown', this.onKeyDown, true);
		// 与 onOpen 同一个目标（window）与同一个 capture 标记，否则解绑不掉
		activeWindow.removeEventListener('keydown', this.onEscapeCapture, true);
		activeDocument.removeEventListener('keyup', this.onKeyUp);
		activeWindow.removeEventListener('blur', this.onWindowBlur);
		// 移动端滑动监听随弹窗关闭解绑。removeEventListener 不关心 passive，对未注册的监听调用也安全
		this.scrollEl.removeEventListener('touchstart', this.onTouchStart);
		this.scrollEl.removeEventListener('touchend', this.onTouchEnd);
		// 平移待命的皮肤（is-pan-ready / is-panning）也要清掉，别留在节点上
		this.endPanReady();
		// 过渡帧比弹窗活得长的话，下一帧会去写已经拆掉的 DOM
		this.cancelViewZoom();
		this.contentEl.empty();
		// 观察器与窗口监听都属于「弹窗存续期间」的资源，关窗必须解绑，否则会跟着窗口一直留着
		this.fitObserver?.disconnect();
		this.fitObserver = null;
		activeWindow.removeEventListener('resize', this.resizeHandler);
		// 移除离屏宿主，不留游离节点
		this.source.dispose?.();
	}

	/**
	 * 把主题的六级标题色搬进弹窗（只在「弹窗文字颜色 = 跟随主题」时调用）。
	 *
	 * 核心给标题写的是 `color: var(--hN-color)`（app.css 的 `h1, .markdown-rendered h1 {
	 * color: var(--h1-color) }`），主题（实测 AnuPpuccin 的 `anp-h1-red` … 六个类）把这六个变量
	 * 声明在 `.app-container` 上。而 Obsidian 把弹窗挂在 `body > .modal-container` —— 与
	 * `.app-container` 是**兄弟节点**，变量传不进来：弹窗里的 `--hN-color` 落到核心 `:root` 的
	 * `--hN-color: inherit`（空值），`color` 于是退回继承正文色。真机实测同一段
	 * `<h2>Test Heading</h2>`：笔记里是 `rgb(250,179,135)`（主题桃色）、弹窗里是
	 * `rgb(198,208,245)`（`--text-normal`）—— 就是「选了跟随主题、标题色却没跟随主题」。
	 *
	 * 把算好的值搬到弹窗根节点后，弹窗里的标题色与笔记逐级一致。这条路径与主题无关：
	 * 只要主题用核心的 `--hN-color` 给标题上色（声明在 `:root` / `body` / `.app-container`
	 * 任一层的算好的值都会出现在 `.app-container` 上），弹窗就能拿到。主题没定义（取到空值）
	 * 时一个变量都不设，保持核心原本的「标题继承正文色」。
	 */
	private applyThemeHeadingColors(): void {
		const appContainer = activeDocument.querySelector<HTMLElement>('.app-container');
		if (!appContainer) return;
		const style = activeWindow.getComputedStyle(appContainer);
		for (const [name, value] of headingColorVariables(style)) {
			this.modalEl.style.setProperty(name, value);
		}
	}

	/**
	 * 切到相邻条目，越界环绕 —— 与内置图片 lightbox 的 navigateMedia 同规则。
	 * 返回 false 让核心执行 preventDefault + stopPropagation，方向键不会冒泡给编辑器；
	 * 只有一条时什么都不做。
	 *
	 * 范围由 `visibleSize/At/Pos` 收口：过滤生效后它只在**命中集**里走（卡片 A12 的
	 * 「退出过滤后条件仍生效」），没有过滤时三个函数退化成全集，与今天一字不差。
	 */
	private step(delta: number): false {
		const size = this.visibleSize();
		if (size > 1) this.show(this.visibleAt((this.visiblePos() + delta + size) % size));
		return false;
	}

	/** 显示第 index 条：读内容 → 复位滚动 → 更新标题 → 重渲染。读取为空时保持当前内容不动。 */
	private show(index: number): void {
		const body = this.source.read(index);
		if (!body) return;
		this.index = index;
		// 从长块切到长块时，浏览器不会自动回到顶部，必须显式复位
		this.scrollEl.scrollTop = 0;
		this.scrollEl.scrollLeft = 0;
		// 视图缩放的锚点属于上一块内容，不复用；同理上一块的「还原位置」也作废
		this.cancelViewZoom();
		this.applyViewZoom(1);
		this.viewZoomReturn = null;
		this.updateTitle();
		void this.renderBody(body);
	}

	/**
	 * 标题栏文案。计数交给 `formatPopupTitle`：有命中走「当前 / 命中数 · 已筛选 (总数)」，
	 * 否则退回今天这一行（只有一条时不加序号，与 1.0.2 完全一致）。
	 */
	private updateTitle(): void {
		const name = this.source.sourceName || t('Magnified view');
		const total = this.source.size;
		const filtered = this.matches.length > 0;
		this.titleEl.setText(
			formatPopupTitle(name, this.visiblePos() + 1, filtered ? this.matches.length : total, total, filtered, t('Filtered')),
		);
	}

	// —— 过滤模式（V123）——

	/** 可过滤的元信息；缺失或长度对不上时返回 null（= 今天的旧行为：不注册 `/`、计数不变）。 */
	private get filterEntries(): readonly PopupEntry[] | null {
		const entries = this.source.entries;
		if (!entries || entries.length !== this.source.size) return null;
		return entries;
	}

	/** 补全的候选池：本篇**实际出现**的类型（去重、按 `TYPE_ORDER` 排序，卡片 A9）。 */
	private get typePool(): PopupEntryType[] {
		return availableTypes(this.filterEntries ?? []);
	}

	private get suggestOpen(): boolean {
		return this.suggestItems.length > 0;
	}

	/** 导航范围：有命中就走命中集，否则走全集。 */
	private visibleSize(): number {
		return this.matches.length || this.source.size;
	}

	/** 命中集 / 全集里第 pos 个 → 全集下标。 */
	private visibleAt(pos: number): number {
		return this.matches.length > 0 ? (this.matches[pos] ?? pos) : pos;
	}

	/** 当前 index 在命中集里的位置；不在命中集里时退回 anchor 所在的位置。 */
	private visiblePos(): number {
		if (this.matches.length === 0) return this.index;
		const at = this.matches.indexOf(this.index);
		if (at >= 0) return at;
		const anchor = this.matches.indexOf(this.filterAnchor);
		return anchor >= 0 ? anchor : 0;
	}

	/**
	 * 打开过滤框并聚焦。返回 false = 这个键被我们吞掉了（Scope 会 preventDefault）。
	 * 不可过滤（没有 entries）或已经开着时返回 true 放行。
	 */
	private openFilter(): boolean {
		if (this.filterOpen || !this.filterEntries) return true;
		this.filterOpen = true;
		this.filterAnchor = this.index;
		this.modalEl.addClass('is-filtering');
		const input = this.filterInputEl;
		if (input) {
			// 恢复上次的条件：卡片 A12「再按 / 回来还在」
			input.value = this.filterValue;
			input.focus();
			const end = input.value.length;
			input.setSelectionRange(end, end);
			this.updateSuggest();
		}
		// `is-filtering` 改了内容区的 padding-bottom，mermaid / Canvas 的 fit 基线要重算（Plan R2）
		this.fitScaledContent();
		return false;
	}

	/**
	 * 收起过滤框。条件与命中集**都留着** —— 「保留」= 退出后 ← → 仍在命中项里走、
	 * 计数仍按命中数显示（[[Discuss-20260925-072827]] Q4 的默认答复）。
	 *
	 * 不刻意把焦点塞回控制条按钮：`modal.ts` 那条注释已记录「焦点会被核心退回 `<body>`」，
	 * 绳子抢不过核心，而空格平移的判据本来就容得下 `target = body`。
	 */
	private closeFilter(): void {
		if (!this.filterOpen) return;
		this.filterOpen = false;
		this.hideSuggest();
		this.modalEl.removeClass('is-filtering');
		this.filterInputEl?.blur();
		this.fitScaledContent();
	}

	/** 清空条件（= 真的没有条件，回到全量）。Ctrl/⌘+C（无选区）与 Ctrl/⌘+U 都走这里。 */
	private clearFilter(): void {
		this.filterValue = '';
		this.matches = [];
		const input = this.filterInputEl;
		if (input) {
			input.value = '';
			input.removeClass('is-no-match');
		}
		this.hideSuggest();
		this.updateTitle();
	}

	/**
	 * 每次输入变化跑一遍：解析 → 算命中集 → 决定标不标红、要不要跳。
	 *
	 * 「未定态一律按全量、不标红」是刻意的：敲到 `@` 或 `@c`（code/callout/canvas 都前缀命中）
	 * 时红盒闪一下是纯噪音，真正「输完了却没命中」才标红（卡片 A6）。
	 */
	private applyFilter(): void {
		const entries = this.filterEntries;
		if (!entries) return;
		const filter = parseFilterInput(this.filterValue, this.typePool);
		const undetermined = filter.field === null && filter.query === '';
		this.matches = undetermined ? [] : matchEntries(entries, filter);
		this.filterInputEl?.toggleClass('is-no-match', !undetermined && this.matches.length === 0);
		if (undetermined) {
			this.updateTitle();
			return;
		}
		const first = this.matches[0];
		if (this.matches.length === 0) {
			// 零命中：回到打开过滤时那一条，弹窗内容不动（卡片 A6）
			if (this.index !== this.filterAnchor) this.show(this.filterAnchor);
			else this.updateTitle();
			return;
		}
		if (this.matches.includes(this.index)) {
			// 已在命中集里：只更新计数，不重渲染（避免每敲一个字画面都闪）
			this.updateTitle();
			return;
		}
		if (first !== undefined) this.show(first);
	}

	/** 在命中项之间移动（↑ / ↓ / Enter）。没有命中集时不动 —— 那时 ↑↓ 本来就无绑定。 */
	private moveMatch(delta: number): void {
		const size = this.matches.length;
		if (size === 0) return;
		this.show(this.visibleAt((this.visiblePos() + delta + size) % size));
	}

	private buildFilter(parentEl: HTMLElement): void {
		const filterEl = parentEl.createDiv({ cls: 'text-popup-filter' });
		const inputEl = filterEl.createEl('input', {
			cls: 'text-popup-filter-input',
			type: 'text',
			attr: {
				'aria-label': t('Filter blocks'),
				placeholder: t('Type to filter, @ for type'),
				spellcheck: 'false',
				autocomplete: 'off',
			},
		});
		const suggestEl = filterEl.createDiv({ cls: 'text-popup-filter-suggest' });
		this.filterInputEl = inputEl;
		this.suggestEl = suggestEl;

		inputEl.addEventListener('input', () => {
			this.filterValue = inputEl.value;
			this.applyFilter();
			this.updateSuggest();
		});
		inputEl.addEventListener('keydown', this.onFilterKeyDown);
		// 焦点离开输入框（点了正文 / Tab 走开）时收起补全：列表跟着光标，没人看就别占着屏幕
		inputEl.addEventListener('blur', () => this.hideSuggest());
	}

	/** 补全弹层：要不要显示、显示哪些。判据见 `suggestionContext`（一敲空格进入 query 段就收起）。 */
	private updateSuggest(): void {
		const input = this.filterInputEl;
		if (!input) return;
		const ctx = suggestionContext(input.value, input.selectionStart ?? input.value.length);
		if (!ctx.showing) {
			this.hideSuggest();
			return;
		}
		this.suggestItems = suggestTypes(ctx.token, this.typePool);
		this.suggestIndex = this.suggestItems.length > 0 ? 0 : -1;
		this.renderSuggest();
	}

	private renderSuggest(): void {
		const suggestEl = this.suggestEl;
		if (!suggestEl) return;
		suggestEl.empty();
		if (this.suggestItems.length === 0) {
			suggestEl.removeClass('is-open');
			return;
		}
		// 类型令牌是 Vim 风格的语法，**不翻译**（与方案 §8 同口径）
		this.suggestItems.forEach((type, i) => {
			suggestEl.createDiv({
				cls: `text-popup-filter-suggest-item${i === this.suggestIndex ? ' is-active' : ''}`,
				text: `@${type}`,
			});
		});
		suggestEl.addClass('is-open');
	}

	private hideSuggest(): void {
		this.suggestItems = [];
		this.suggestIndex = -1;
		this.suggestEl?.removeClass('is-open');
		this.suggestEl?.empty();
	}

	private moveSuggest(delta: number): void {
		const size = this.suggestItems.length;
		if (size === 0) return;
		this.suggestIndex = (this.suggestIndex + delta + size) % size;
		this.renderSuggest();
	}

	/** 采纳当前高亮项：把 `@token` 换成 `@type `，光标落到末尾，保持过滤态。 */
	private acceptSuggest(): void {
		const input = this.filterInputEl;
		const type = this.suggestItems[this.suggestIndex];
		if (!input || !type) return;
		const value = input.value;
		const boundary = /\s/.exec(value)?.index ?? value.length;
		// 后面没内容时补一个空格：既让补全立刻收起，也让用户能接着打 query
		const next = `@${type}${value.slice(boundary) || ' '}`;
		input.value = next;
		input.setSelectionRange(next.length, next.length);
		this.filterValue = next;
		this.hideSuggest();
		this.applyFilter();
	}

	/**
	 * `Esc` 的 capture 监听：过滤态下先收补全、再收过滤框，收完就把事件掐断 —— 核心的
	 * 「Esc 关弹窗」因此看不到它。不在过滤态时一律放行（弹窗照常关）。
	 *
	 * 判据「是不是别人的弹窗」与空格那条（`onKeyDown`）同写法：焦点可能已被核心退回 `<body>`，
	 * 所以只看「事件目标落在**别的** `.modal-container` 里」—— 那时该键归上面那层弹窗。
	 */
	private onEscapeCapture = (evt: KeyboardEvent): void => {
		if (evt.key !== 'Escape' || evt.isComposing || !this.filterOpen) return;
		const holder = evt.target instanceof Element ? evt.target.closest('.modal-container') : null;
		if (holder && !holder.contains(this.modalEl)) return;
		evt.preventDefault();
		evt.stopPropagation();
		if (this.suggestOpen) {
			this.hideSuggest();
			return;
		}
		this.closeFilter();
	};

	/**
	 * 输入框自己的 keydown。
	 *
	 * 顺序即优先级：补全打开时 ↑↓/Enter/Tab 全归补全；否则 ↑↓ 走命中项、Enter 跳下一个命中项。
	 * `Esc` **不在这里处理** —— 让它冒泡到弹窗 scope 上统一判「关补全 / 收过滤框 / 关弹窗」。
	 */
	private onFilterKeyDown = (evt: KeyboardEvent): void => {
		// 输入法拼字中一律放行：中文候选还没上屏时 Enter / Esc 是「确认 / 取消候选」，
		// 被我们截走的话中文用户第一个字就打不出来（Plan §10 R3，真机 K6 验）
		if (evt.isComposing) return;
		if (this.suggestOpen) {
			if (evt.key === 'ArrowDown') {
				evt.preventDefault();
				this.moveSuggest(1);
				return;
			}
			if (evt.key === 'ArrowUp') {
				evt.preventDefault();
				this.moveSuggest(-1);
				return;
			}
			// Tab 只在补全打开时截获：不打开时不截，那会把键盘用户的焦点环切断
			if (evt.key === 'Enter' || evt.key === 'Tab') {
				evt.preventDefault();
				this.acceptSuggest();
				return;
			}
		}
		if (evt.key === 'ArrowUp') {
			evt.preventDefault();
			this.moveMatch(-1);
			return;
		}
		if (evt.key === 'ArrowDown' || evt.key === 'Enter') {
			evt.preventDefault();
			this.moveMatch(1);
			return;
		}
		if (evt.ctrlKey || evt.metaKey) {
			const key = evt.key.toLowerCase();
			if (key !== 'c' && key !== 'u') return;
			// `Ctrl/⌘+C` 只在「框内没有选区」时才当清空：有选区时它是复制
			// （无选区时它本来什么都不做，所以吞掉不损失任何既有行为）
			const input = this.filterInputEl;
			const selected =
				input !== null &&
				input.selectionStart !== null &&
				input.selectionEnd !== null &&
				input.selectionEnd > input.selectionStart;
			if (key === 'c' && selected) return;
			evt.preventDefault();
			this.clearFilter();
		}
	};

	/**
	 * 渲染一条内容。
	 *
	 * 每次切换都渲染到一个**全新的容器**，成功后才撤掉上一屏：render 是 append 语义、又是异步的，
	 * 连按方向键时两次渲染会交错写进同一个容器导致内容串台。独立容器 + renderToken
	 * 丢弃过期渲染可彻底规避，且不会出现「清空后等异步」的空白闪烁。
	 */
	private async renderBody(body: TextPopupBody): Promise<void> {
		const token = ++this.renderToken;

		const textEl = this.scrollEl.createDiv({ cls: 'text-popup-text' });
		this.textEl?.remove();
		this.textEl = textEl;

		// 自渲染通道（目前只有 Canvas 快照）：候选自己产出 DOM，`render` 存在时优先于 `rich`。
		// 与 rich 那条同一套生命周期：子组件挂到弹窗根组件下，随弹窗关闭自动 unload。
		if (body.render) {
			const child = this.component.addChild(new Component());
			textEl.addClass('is-canvas');
			try {
				await body.render(textEl, child);
			} catch (error) {
				console.error('[text-popup] Canvas 快照渲染失败，已回退为纯文本', error);
			}
			if (token !== this.renderToken) {
				// 已被后续的切换取代：丢弃本次渲染，顺手释放它的子组件
				this.component.removeChild(child);
				return;
			}
			// 判据与下面 rich 那条同一条：覆盖「只画出一张画布、没有文字」的情况。
			// 画布空 / 坏时容器是空的 → 落到下面的 plain 分支显示文件名，不会是一屏空白。
			if (textEl.textContent?.trim() || textEl.childElementCount > 0) {
				this.fitScaledContent(); // 先主动算一次；晚到的异步内容由 fitObserver 补
				return;
			}
			this.component.removeChild(child);
			textEl.empty();
			textEl.removeClass('is-canvas');
		}

		if (this.settings.renderRichText && body.rich) {
			// 子组件挂到弹窗根组件下：addChild 随父组件的 load 状态自动 load，
			// removeChild 会自动 unload —— 不要再手写 load / unload。
			const child = this.component.addChild(new Component());
			textEl.addClass('markdown-rendered', 'is-rich');
			try {
				await MarkdownRenderer.render(
					this.app,
					body.rich,
					textEl,
					this.source.sourcePath,
					child,
				);
				if (token !== this.renderToken) {
					// 已被后续的切换取代：丢弃本次渲染，顺手释放它的子组件
					this.component.removeChild(child);
					return;
				}
				// 判据用「有文本 或 有子元素」，覆盖「只渲染出一张图片、没有文字」的情况。
				if (textEl.textContent?.trim() || textEl.childElementCount > 0) {
					this.fitScaledContent(); // 先主动算一次；svg 晚到的那些由 fitObserver 补
					return;
				}
			} catch (error) {
				console.error('[text-popup] 富文本渲染失败，已回退为纯文本', error);
			}
			this.component.removeChild(child);
			textEl.empty();
			textEl.removeClass('markdown-rendered', 'is-rich');
		}
		textEl.addClass('is-plain');
		textEl.setText(body.plain);
	}

	/**
	 * 让「有自己固有尺寸的异步内容」在 scale = 1 时「一屏刚好装下」。
	 *
	 * 目前两类：mermaid 的 svg（给它写 `--tp-mermaid-w`，见 styles.css）与 Canvas 只读快照
	 * （给外层 `.text-popup-canvas-fit` 写 `--tp-canvas-fit`）。两者口径同族但**上界不同**：
	 * mermaid 允许放大到 2 倍（`MERMAID_MAX_FIT`），画布的上界是 1（小画布不放大 —— 与图片
	 * lightbox「按可用盒子装下、小图不放大」一致）。
	 *
	 * 为什么逐图算（mermaid 那条）：各图 aspect 差得极远（实测 viewBox 100×298 ~ 546×450），
	 * 共用一个全局缩放比必然让其中一批过大、另一批过小 —— 这正是 Plan-20260919-171610 要修的病根。
	 * 为什么读 viewBox 而不是量 svg 当前尺寸：svg 上的 width 正是我们自己在控制，量它等于拿结果
	 * 当输入；viewBox 才是图自己的坐标系，与弹窗宽度无关。
	 * 为什么写 CSS 变量而不是直接写 width：缩放档位变化时只需改弹窗根节点的
	 * --text-popup-mermaid-scale（updateSize 已经在做），不必重新遍历 DOM。
	 *
	 * 画布那条读的是 `--tp-canvas-w/h`（画布包围盒尺寸，由 canvas.ts 写在 `.text-popup-canvas-fit`
	 * 上），算出 fit 后写 `--tp-canvas-fit`；可用盒取的是 `.text-popup-text` 的父级
	 * `.text-popup-content` 的内容盒，**不量 `.text-popup-text` 本身** —— 它是 width: auto 的 flex 项，
	 * 量它会把 V119 修过的「退回 UA 300px」那个坑再挖一遍。
	 *
	 * 时序：svg 由 mermaid 异步插入，实测比正文容器晚约 5ms、在另一个 task 里
	 * （`[["keydown",444419],["textEl",444419],["svg",444424]]`）—— 即 `await MarkdownRenderer.render()`
	 * 返回与「svg 已在 DOM 里」没有保证的先后关系，只在渲染后同步量一次会偶发漏算
	 * （漏算的那张退回 CSS fallback = 旧行为）。Canvas 快照同理（节点盒要等 MarkdownRenderer）。
	 * 所以 renderBody 主动算一次 + fitObserver 盯着新插入的内容补算；observer 回调是微任务、
	 * 在 paint 之前跑，不会闪一帧。
	 */
	private fitScaledContent(): void {
		const style = activeWindow.getComputedStyle(this.scrollEl);
		const availW =
			this.scrollEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		const availH =
			this.scrollEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
		if (availW <= 0 || availH <= 0) return; // 弹窗还没布局出来（或窗口被压得极小）
		this.scrollEl.querySelectorAll<SVGSVGElement>('.mermaid > svg').forEach((svg) => {
			const box = svg.viewBox.baseVal;
			if (!box.width || !box.height) return; // 没有 viewBox 的 svg：留给 CSS 的 fallback
			// 图在 callout 里时容器比内容区窄，可用宽要按容器算。.mermaid 是 width:100% 的块级元素，
			// 宽度由父级确定、不会因为 svg 变宽而回授，所以这样取是安全的；不在 callout 里时
			// parentW 就等于内容区宽，Math.min 是恒等操作。
			const parentW = svg.parentElement?.clientWidth ?? 0;
			const width = parentW > 0 ? Math.min(availW, parentW) : availW;
			const fit = Math.min(width / box.width, availH / box.height, MERMAID_MAX_FIT);
			svg.style.setProperty('--tp-mermaid-w', `${(box.width * fit).toFixed(2)}px`);
		});
		// Canvas 快照：尺寸来自画布坐标系（1:1 当 px），上界 1 = 只缩不放
		this.scrollEl.querySelectorAll<HTMLElement>('.text-popup-canvas-fit').forEach((fitEl) => {
			const computed = activeWindow.getComputedStyle(fitEl);
			const width = parseFloat(computed.getPropertyValue('--tp-canvas-w'));
			const height = parseFloat(computed.getPropertyValue('--tp-canvas-h'));
			if (!(width > 0) || !(height > 0)) return; // 尺寸没写上：留给 CSS 的 fallback（fit = 1）
			const fit = Math.min(1, availW / width, availH / height);
			fitEl.style.setProperty('--tp-canvas-fit', String(fit));
		});
	}

	private buildControls(parentEl: HTMLElement): void {
		const controlsEl = parentEl.createDiv({ cls: 'text-popup-controls' });

		const fontGroupEl = controlsEl.createDiv({ cls: 'text-popup-control-group' });
		fontGroupEl.createSpan({ cls: 'text-popup-control-label', text: t('Font size') });
		this.createControlButton(fontGroupEl, 'minus', t('Decrease font size'), () =>
			this.stepFontSize(-1),
		);
		this.fontSizeValueEl = fontGroupEl.createSpan({ cls: 'text-popup-control-value' });
		this.createControlButton(fontGroupEl, 'plus', t('Increase font size'), () =>
			this.stepFontSize(1),
		);

		const zoomGroupEl = controlsEl.createDiv({ cls: 'text-popup-control-group' });
		zoomGroupEl.createSpan({ cls: 'text-popup-control-label', text: t('Zoom') });
		this.createControlButton(zoomGroupEl, 'zoom-out', t('Zoom out'), () => this.stepZoom(-1));
		this.zoomValueEl = zoomGroupEl.createSpan({ cls: 'text-popup-control-value' });
		this.createControlButton(zoomGroupEl, 'zoom-in', t('Zoom in'), () => this.stepZoom(1));

		this.createControlButton(controlsEl, 'rotate-ccw', t('Reset'), () => this.resetSize());
	}

	private createControlButton(
		parentEl: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const buttonEl = parentEl.createDiv({ cls: 'text-popup-control-button' });
		buttonEl.setAttribute('role', 'button');
		buttonEl.setAttribute('tabindex', '0');
		buttonEl.setAttribute('aria-label', label);
		setIcon(buttonEl, icon);
		buttonEl.addEventListener('click', onClick);
		// 空格归平移（由 onKeyDown 在 capture 阶段收走），这里只认 Enter；`repeat` 一并忽略 ——
		// 没有它时按住键的每一次自动重复都是一次完整的 onClick（字号 / 缩放一路变）。
		buttonEl.addEventListener('keydown', (evt) => {
			if (evt.key !== 'Enter' || evt.repeat) return;
			evt.preventDefault();
			onClick();
		});
	}

	private stepFontSize(direction: number): void {
		this.fontSize = clamp(this.fontSize + direction * FONT_SIZE_STEP, FONT_SIZE_MIN, FONT_SIZE_MAX);
		this.updateSize();
	}

	private stepZoom(direction: number): void {
		this.zoom = round1(clamp(this.zoom + direction * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
		this.updateSize();
	}

	private resetSize(): void {
		this.fontSize = this.settings.popupFontSize;
		this.zoom = DEFAULT_ZOOM;
		// 「恢复默认」要名副其实：字号、缩放、视图缩放三者全复原
		this.cancelViewZoom();
		this.applyViewZoom(1);
		this.viewZoomReturn = null;
		this.updateSize();
	}

	/**
	 * Alt+Click：未放大时以点击点为锚放大、并把它推到画布中心；已放大时还原到进入前的位置。
	 *
	 * 两端的 scale 与滚动位置先一次算清，再交给 `animateViewZoom` 插值过去 —— 过渡期间用户
	 * 再点一下也只是换一对新的起止值（起点取当前实际值），不会跳。
	 *
	 * 点击点坐标用 `getBoundingClientRect()` 现算，而不是自己累加内边距 / `margin: auto` 的偏移：
	 * `transform-origin: 0 0` 下缩放后的包围盒左上角与缩放前重合，所以 rect 的 left/top 就是
	 * 元素的未缩放原点（见 elementPoint）。
	 */
	private toggleClickZoom(clientX: number, clientY: number): void {
		const current = this.viewZoom;
		const next = clickZoomTarget(current, CLICK_ZOOM_FACTOR);
		const from = { left: this.scrollEl.scrollLeft, top: this.scrollEl.scrollTop };

		if (current === 1) {
			// 先记下「放大前看到哪儿」：再点一下还原时写回它（「刚才看到哪儿」优先于「居中到哪儿」）
			this.viewZoomReturn = from;
			const rect = this.textEl?.getBoundingClientRect();
			const point = rect ? elementPoint(clientX, clientY, rect, current) : { x: 0, y: 0 };
			// 两项之和：zoomScrollDelta 让点击处**不动**（补偿放大本身），scrollToMove 再把它
			// 从原位置**推到画布中心**（V116 第二次反馈要的 reveal.js 手感，见 Plan-20260920-161511 §2.2）。
			// 点击处离文档边缘太近时居中量会被滚动上限夹掉（做不到居中），内容不会丢。
			// 残余误差 ≤ 1.3px，来自浏览器把滚动位置按设备像素对齐（本机 DPR 1.728）；算式本身没有
			// 偏差，详见 Report-20260920-155615。
			const delta = zoomScrollDelta(current, next, point);
			const shift = scrollToMove({ x: clientX, y: clientY }, viewportCenter(this.scrollEl));
			// 两项之和要先夹进「next 倍数下真正可达的范围」再交给过渡：算出来的目标常常是够不着的
			// （点击落在画布左侧时实测要 1191、而上限只有 875），终点不可达会让收尾帧解成
			// 「滚动写 0、整段交给平移」、平移收不回来（见 clampScroll / resolveViewFrame）。
			// 夹完后的终点与不夹时浏览器自己夹出来的完全相同，用户看到的落点不会变。
			const target = clampScroll(
				{ left: from.left + delta.left + shift.left, top: from.top + delta.top + shift.top },
				this.reachableScroll(next),
			);
			this.animateViewZoom({ fromScale: current, toScale: next, fromScroll: from, toScroll: target });
			return;
		}

		// 从 2× 回到 1× 不需要算补偿：回到进入前的位置即可（浏览器自己会把越界值夹回范围内）
		const back = this.viewZoomReturn ?? from;
		this.viewZoomReturn = null;
		this.animateViewZoom({ fromScale: current, toScale: next, fromScroll: from, toScroll: back });
	}

	/**
	 * 以 (clientX, clientY) 为锚，把视图缩放瞬时改为 next。
	 *
	 * 与 `toggleClickZoom` 共用两个几何算式（`elementPoint` / `zoomScrollDelta`），差别在三处：
	 * 不加 `scrollToMove`（那是「把点击处推到画布中心」的 reveal.js 手感，滚轮不该有）、走瞬时
	 * 而不是 500ms 过渡（滚轮是连续手势，一条过渡会被下一次滚轮反复打断）、不先用 `clampScroll`
	 * 夹终点（理由见下）。
	 *
	 * 落位只有两步（推导见 `settleZoomFrame`，这里是它的调用方）：
	 * ① 先把「这一帧从内容自然位算起一共要挪多少」算出来 —— 总位移 `desired` 减去**上一格留下的
	 *    平移**。那一截平移已经在屏幕上生效，这一格的补偿必须接在它后面；漏掉它内容就会按
	 *    「漏掉的那一截」跳一下，连续滚轮时每格都跳，即肉眼看到的抖动（真机实测每格跳 43.8px，
	 *    精确等于上一格的 pan，见 Plan-20260923-055530 §1.3）。
	 * ② 按它放不放得进可达滚动区间二选一：放得下 → 滚动全担、平移清零；放不下 → 滚动写 0、
	 *    整段交给平移。两个分支的屏幕落位相同，但只有前者是用户能自己滚回来的。
	 *
	 * 上限必须用 `reachableScroll(next)` 先量、而不是「写完滚动再读回」：读回值是在**平移归零**
	 * 的状态下量出来的，而终态可能带着平移 —— 平移会缩小可滚区间，浏览器事后会把刚写的滚动再夹
	 * 一次（实测判为「放得下」的 158.77，应用平移后被夹成 97.2 → 仍漂 61.5px，见该方案 §8-A）。
	 * `reachableScroll` 同样以 `NO_PAN` 量，与分支①「平移清零」的终态是同一个数 —— 这一点必须对齐。
	 *
	 * 不先用 `clampScroll` 夹目标：那是给**过渡的终点**用的（终点不可达时收尾帧会把平移收不回来，
	 * 见 clampScroll 的注释）。单帧版没有「收尾帧」，写进去的滚动放不下就整段交给平移，落位一致。
	 */
	private zoomAtPoint(clientX: number, clientY: number, next: number): void {
		const current = this.viewZoom;
		const from = { left: this.scrollEl.scrollLeft, top: this.scrollEl.scrollTop };
		const rect = this.textEl?.getBoundingClientRect();
		const point = rect ? elementPoint(clientX, clientY, rect, current) : { x: 0, y: 0 };
		const delta = zoomScrollDelta(current, next, point);
		const desired = { left: from.left + delta.left, top: from.top + delta.top };
		// 上一格留下的平移必须先取：它已经在屏幕上生效，这一格的补偿要接在它后面。
		// 丢了它内容就会按「丢掉的那一截」跳一下 —— 连续滚轮时每格都跳，即肉眼看到的抖动。
		const carry = this.viewPan;
		const settled = settleZoomFrame(
			{ left: desired.left - carry.left, top: desired.top - carry.top },
			this.reachableScroll(next),
		);
		this.applyViewTransform(next, settled.pan);
		this.scrollEl.scrollLeft = settled.scroll.left;
		this.scrollEl.scrollTop = settled.scroll.top;
	}

	/**
	 * 把视图缩放从当前状态过渡到 `tween` 的目标状态。
	 *
	 * 为什么 scale 与滚动都用 JS 逐帧写、而不是给 transform 加一条 CSS transition：屏幕坐标 =
	 * 元素原点 − 滚动量 + scale × 元素本地坐标，两者必须**同进度**地一起动（推导见 zoomTweenFrame）。
	 * CSS transition 只管 transform 这一项，滚动还得靠另一条时间线去追，两条时间线一定会错开，
	 * 中途就能看到锚点漂移。逐帧自己写则天然同步，且只留一条缓动曲线。
	 *
	 * **每帧都必须先写 scale 变量、再写滚动量**（与旧版瞬时写入同因）：滚动赋值会被夹在当前的
	 * 滚动上限上，而滚动上限由 scale 决定；反过来的话这一帧的滚动会被夹在上一帧（更小）的上限上，
	 * 锚点漂移。写 CSS 变量本身不会强制布局，是紧接着的滚动赋值顺带把新上限算出来的。
	 *
	 * 还有一层：**写进去的滚动量不一定会生效** —— 可滚区间是随 scale 变的，zoom in 与 zoom out
	 * 各有一种塌法（成因见 resolveViewFrame），浏览器的夹取会把这一帧的滚动钉在上限上，上述
	 * 「同进度」的前提就被打破了。所以每帧还要把真正生效的值读回来、把差额交给平移补偿。
	 */
	private animateViewZoom(tween: ZoomTween): void {
		this.cancelViewZoom();
		if (prefersReducedMotion()) {
			this.applyViewZoom(tween.toScale);
			this.scrollEl.scrollLeft = tween.toScroll.left;
			this.scrollEl.scrollTop = tween.toScroll.top;
			return;
		}

		// 上一段过渡没收回的平移交给 carry，按进度收回，中途被打断时不会瞬间抹掉。
		const carry = this.viewPan;
		// 零点取**第一帧的 timestamp**、而不是发出请求的时刻：rAF 的回调比请求晚一帧左右，
		// 拿请求时刻当零点会让这段差值凭空吃掉一部分进度（表现为第一帧就跳一段）。
		// 帧回调挂在 activeWindow 上（与 onOpen 的 activeWindow.addEventListener 同理）：
		// 弹窗可以被拖到 pop-out 窗口里，裸的 requestAnimationFrame 认的是主窗口。
		const win = activeWindow;
		let start: number | null = null;
		const step = (now: number): void => {
			start ??= now;
			const progress = Math.min(1, (now - start) / VIEW_ZOOM_DURATION);
			const { scale, scroll } = zoomTweenFrame(tween, progress);
			// 平移必须先归零再写滚动量：平移会缩小可滚区间，先归零读到的才是内容块自身的上限
			this.applyViewTransform(scale, NO_PAN);
			this.scrollEl.scrollLeft = scroll.left;
			this.scrollEl.scrollTop = scroll.top;
			const settled = resolveViewFrame(
				scroll,
				{ left: this.scrollEl.scrollLeft, top: this.scrollEl.scrollTop },
				carry,
				// 与 scale / 滚动同一条缓动曲线，否则残留的收回节奏与缩放对不上
				easeOutCubic(progress),
			);
			this.scrollEl.scrollLeft = settled.scroll.left;
			this.scrollEl.scrollTop = settled.scroll.top;
			this.applyViewTransform(scale, settled.pan);
			if (progress < 1) {
				this.viewZoomFrame = { win, id: win.requestAnimationFrame(step) };
				return;
			}
			this.viewZoomFrame = null;
			// 收尾提交的正是**这一帧解算出来的状态**，而不是「写一次精确的终态、顺便把平移清零」：
			// 终点可达时 settled.pan 本来就是 0（残留收到 0、目标放得下），两者等价；万一量出来的上限
			// 与浏览器的夹取差个零点几像素、这一帧被解成「整段交给平移」，清零会让内容在收尾跳一大段。
			// 回到 1× 时 applyViewTransform 自己会把平移归零、把 transform 摘掉（见 applyViewTransform）。
			this.applyViewTransform(tween.toScale, settled.pan);
		};
		this.viewZoomFrame = { win, id: win.requestAnimationFrame(step) };
	}

	/** 停掉正在跑的过渡。过渡只是观感，随时可以被一条「直接要终态」的路径打断。 */
	private cancelViewZoom(): void {
		if (this.viewZoomFrame === null) return;
		this.viewZoomFrame.win.cancelAnimationFrame(this.viewZoomFrame.id);
		this.viewZoomFrame = null;
	}

	/**
	 * 某个倍数下**真正可达**的滚动上限（`scrollWidth − clientWidth` 那一对值）。
	 *
	 * 为什么量而不是算：上限取决于内容块超出可视区的那部分，而内容块是横着居中（`margin: auto`）、
	 * 竖着贴边的 —— 两轴的式子不一样（真机实测 2× 下横向 875、纵向 10798），照「内容尺寸 × 倍数」算
	 * 必错。量法是把倍数**临时**写上去、读一次、再还原：全程同步、中间没有 paint，用户看不到。
	 *
	 * 量之前先把平移归零（`NO_PAN`）：平移会让内容块末端内缩、可滚区间跟着变小，而每帧解算读到的
	 * 也是「平移归零后」的上限，两者必须是同一个数（见 animateViewZoom）。
	 */
	private reachableScroll(scale: number): ScrollOffset {
		const el = this.scrollEl;
		const zoom = this.viewZoom;
		const pan = this.viewPan;
		const scroll = { left: el.scrollLeft, top: el.scrollTop };
		this.applyViewTransform(scale, NO_PAN);
		const limit = { left: el.scrollWidth - el.clientWidth, top: el.scrollHeight - el.clientHeight };
		// 按进来时的状态原样还原：倍数、平移、滚动位置三个值一个都不能留在临时状态上
		this.applyViewTransform(zoom, pan);
		el.scrollLeft = scroll.left;
		el.scrollTop = scroll.top;
		return limit;
	}

	/**
	 * 写视图缩放与平移补偿。
	 *
	 * 1× 时**必须**把 transform 整个摘掉（computed 变 `none`），不能只把 scale 写成 1：Chromium 会把
	 * 「带 transform 的子树」对滚动区的贡献缓存住，2× → 1× 的 scale 变化不会触发重算，滚动区会停在
	 * 放大后的尺寸（实测点「恢复默认」后 scrollWidth/scrollHeight 停在 1701 / 7791，而正文只有
	 * 1481 / 3992 —— 能滚到正文之外的空白）。所以 1× 时连平移一起清零，这总是安全的：回到 1× 的过渡
	 * 终点是**真实到过的滚动位置**（`viewZoomReturn` 或当前值），补偿本来就收到 0。详见 styles.css 与
	 * Report-20260920-155615。
	 *
	 * 过渡期间由 `animateViewZoom` 每帧用一个中间值调用它：类在插值一开始（scale 刚离开 1）就挂上，
	 * 一直留到收尾那一帧写回精确的 1 才摘掉 —— 「挂上 / 摘掉」各只发生一次，中间帧只改变量与平移。
	 */
	private applyViewTransform(scale: number, pan: ScrollOffset): void {
		const zoomed = scale !== 1;
		this.viewZoom = scale;
		this.viewPan = zoomed ? pan : NO_PAN;
		this.modalEl.style.setProperty('--text-popup-view-scale', String(scale));
		this.modalEl.style.setProperty('--text-popup-pan-x', `${this.viewPan.left}px`);
		this.modalEl.style.setProperty('--text-popup-pan-y', `${this.viewPan.top}px`);
		this.modalEl.toggleClass('is-view-zoomed', zoomed);
	}

	/** 只改倍数、把平移清掉（「恢复默认」、切换条目、以及不补偿的那些帧都走这条路）。 */
	private applyViewZoom(scale: number): void {
		this.applyViewTransform(scale, NO_PAN);
	}

	/** 结束一次拖拽：清起点与拖拽皮肤。松开空格前仍保持平移待命（光标还是抓手）。 */
	private endPan(): void {
		this.panOrigin = null;
		this.scrollEl.removeClass('is-panning');
	}

	/** 退出平移待命：松开空格 / 窗口失焦 / 关窗时调用，拖拽中也会一并结束。 */
	private endPanReady(): void {
		this.spaceDown = false;
		this.panOrigin = null;
		this.scrollEl.removeClass('is-pan-ready', 'is-panning');
	}

	/** 缩放以倍数作用于字号，因此内容始终自然重排，不会出现被裁切的情况。 */
	private updateSize(): void {
		const effectiveSize = Math.round(this.fontSize * this.zoom);
		this.modalEl.style.setProperty('--text-popup-font-size', `${effectiveSize}px`);
		// mermaid 是矢量图：字号 / 缩放都换算成「整图缩放比」，乘在 fit 基线上（1 = 一屏装下）。
		// 夹上下限：不夹时理论区间是 0.375 ~ 18，18 倍毫无使用价值（见 MERMAID_SCALE_MAX）。
		this.modalEl.style.setProperty(
			'--text-popup-mermaid-scale',
			String(
				clamp(
					effectiveSize / this.settings.popupFontSize,
					MERMAID_SCALE_MIN,
					MERMAID_SCALE_MAX,
				),
			),
		);
		this.fontSizeValueEl?.setText(`${this.fontSize} px`);
		this.zoomValueEl?.setText(`${Math.round(this.zoom * 100)}%`);
	}
}
