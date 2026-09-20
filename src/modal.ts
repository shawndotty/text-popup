import { App, Component, MarkdownRenderer, Modal, setIcon } from 'obsidian';
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
 * - 内容默认交给 MarkdownRenderer 渲染 HTML 与 Markdown，失败时回退纯文本。
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
	/** 盯着 mermaid 的 svg 被异步插进来（时序见 fitMermaid）；onClose 里断开。 */
	private mermaidObserver: MutationObserver | null = null;
	/** 弹窗铺满窗口，窗口尺寸变了 fit 就过期；存成字段才能在 onClose 里解绑。 */
	private resizeHandler = (): void => this.fitMermaid();
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
		this.scope.register(null, 'ArrowLeft', () => this.step(-1));
		this.scope.register(null, 'ArrowRight', () => this.step(1));

		// 文字外面再包一层，方便用 margin: auto 在满屏窗口里居中：
		// 内容短时居中显示，内容长时仍可从头滚动。
		this.scrollEl = this.contentEl.createDiv({ cls: 'text-popup-content' });

		// mermaid 的 svg 是异步插进来的（实测比正文容器晚约 5ms、在另一个 task 里，见 fitMermaid），
		// 所以除了渲染后主动算一次，还要盯着新插入的 svg 补算。
		this.mermaidObserver = new MutationObserver(() => this.fitMermaid());
		// 只监听 childList：fitMermaid 改的是 svg 的 style（属性变更），不会自触发成死循环。
		this.mermaidObserver.observe(this.scrollEl, { childList: true, subtree: true });
		// 弹窗铺满窗口，窗口尺寸变了 fit 就过期
		activeWindow.addEventListener('resize', this.resizeHandler);

		// 视图缩放（Alt+Click）与空格平移：都只挂正文区，控制条 / 标题栏不受影响。
		this.scrollEl.addEventListener('mousedown', this.onMouseDown);
		this.scrollEl.addEventListener('click', this.onClick);
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

		this.buildControls(this.contentEl);
		this.updateSize();

		this.show(this.index);
	}

	onClose(): void {
		this.component.unload();
		// 视图缩放 / 平移的监听同样属于「弹窗存续期间」的资源，逐一解绑
		this.scrollEl.removeEventListener('mousedown', this.onMouseDown);
		this.scrollEl.removeEventListener('click', this.onClick);
		this.scrollEl.removeEventListener('pointerdown', this.onPointerDown);
		activeDocument.removeEventListener('pointermove', this.onPointerMove);
		activeDocument.removeEventListener('pointerup', this.onPointerUp);
		activeDocument.removeEventListener('pointercancel', this.onPointerCancel);
		// capture 标记必须与 onOpen 里一致，否则这个监听解绑不掉
		activeDocument.removeEventListener('keydown', this.onKeyDown, true);
		activeDocument.removeEventListener('keyup', this.onKeyUp);
		activeWindow.removeEventListener('blur', this.onWindowBlur);
		// 平移待命的皮肤（is-pan-ready / is-panning）也要清掉，别留在节点上
		this.endPanReady();
		// 过渡帧比弹窗活得长的话，下一帧会去写已经拆掉的 DOM
		this.cancelViewZoom();
		this.contentEl.empty();
		// 观察器与窗口监听都属于「弹窗存续期间」的资源，关窗必须解绑，否则会跟着窗口一直留着
		this.mermaidObserver?.disconnect();
		this.mermaidObserver = null;
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
	 */
	private step(delta: number): false {
		const size = this.source.size;
		if (size > 1) this.show((this.index + delta + size) % size);
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

	/** 只有一条时不加序号：标题与 1.0.2 完全一致。 */
	private updateTitle(): void {
		const name = this.source.sourceName || t('Magnified view');
		const total = this.source.size;
		this.titleEl.setText(total > 1 ? `${name} · ${this.index + 1} / ${total}` : name);
	}

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
					this.fitMermaid(); // 先主动算一次；svg 晚到的那些由 mermaidObserver 补
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
	 * 让每张 mermaid 图在 scale = 1 时「一屏刚好装下」：给 svg 写 `--tp-mermaid-w`（见 styles.css）。
	 *
	 * 为什么逐图算：各图 aspect 差得极远（实测 viewBox 100×298 ~ 546×450），共用一个全局缩放比
	 * 必然让其中一批过大、另一批过小 —— 这正是 Plan-20260919-171610 要修的病根。
	 * 为什么读 viewBox 而不是量 svg 当前尺寸：svg 上的 width 正是我们自己在控制，量它等于拿结果
	 * 当输入；viewBox 才是图自己的坐标系，与弹窗宽度无关。
	 * 为什么写 CSS 变量而不是直接写 width：缩放档位变化时只需改弹窗根节点的
	 * --text-popup-mermaid-scale（updateSize 已经在做），不必重新遍历 DOM。
	 *
	 * 时序：svg 由 mermaid 异步插入，实测比正文容器晚约 5ms、在另一个 task 里
	 * （`[["keydown",444419],["textEl",444419],["svg",444424]]`）—— 即 `await MarkdownRenderer.render()`
	 * 返回与「svg 已在 DOM 里」没有保证的先后关系，只在渲染后同步量一次会偶发漏算
	 * （漏算的那张退回 CSS fallback = 旧行为）。所以 renderBody 主动算一次 +
	 * mermaidObserver 盯着新插入的 svg 补算；observer 回调是微任务、在 paint 之前跑，不会闪一帧。
	 */
	private fitMermaid(): void {
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
			this.animateViewZoom({
				fromScale: current,
				toScale: next,
				fromScroll: from,
				toScroll: { left: from.left + delta.left + shift.left, top: from.top + delta.top + shift.top },
			});
			return;
		}

		// 从 2× 回到 1× 不需要算补偿：回到进入前的位置即可（浏览器自己会把越界值夹回范围内）
		const back = this.viewZoomReturn ?? from;
		this.viewZoomReturn = null;
		this.animateViewZoom({ fromScale: current, toScale: next, fromScroll: from, toScroll: back });
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
	 */
	private animateViewZoom(tween: ZoomTween): void {
		this.cancelViewZoom();
		if (prefersReducedMotion()) {
			this.applyViewZoom(tween.toScale);
			this.scrollEl.scrollLeft = tween.toScroll.left;
			this.scrollEl.scrollTop = tween.toScroll.top;
			return;
		}

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
			this.applyViewZoom(scale);
			this.scrollEl.scrollLeft = scroll.left;
			this.scrollEl.scrollTop = scroll.top;
			if (progress < 1) {
				this.viewZoomFrame = { win, id: win.requestAnimationFrame(step) };
				return;
			}
			this.viewZoomFrame = null;
			// 收尾写一次精确值：插值到 1× 时 applyViewZoom 顺手把 transform 摘掉（见 applyViewZoom）
			this.applyViewZoom(tween.toScale);
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
	 * 写视图缩放变量，并在 1× 时把 transform 整个摘掉（去掉 `.is-view-zoomed`）。
	 *
	 * 不能只是把变量写成 `scale(1)`：Chromium 会把「带 transform 的子树」对滚动区的贡献缓存住，
	 * 2× → 1× 的 scale 变化不会触发重算，滚动区会停在放大后的尺寸（实测点「恢复默认」后
	 * scrollWidth/scrollHeight 停在 1701 / 7791，而正文只有 1481 / 3992 —— 能滚到正文之外的空白）。
	 * 摘掉 transform（computed 变 `none`）才会重算。详见 styles.css 与 Report-20260920-155615。
	 *
	 * 过渡期间由 `animateViewZoom` 每帧用一个中间值调用它：类在插值一开始（scale 刚离开 1）就挂上，
	 * 一直留到收尾那一帧写回精确的 1 才摘掉 —— 「挂上 / 摘掉」各只发生一次，中间帧只改变量。
	 */
	private applyViewZoom(scale: number): void {
		this.viewZoom = scale;
		this.modalEl.style.setProperty('--text-popup-view-scale', String(scale));
		this.modalEl.toggleClass('is-view-zoomed', scale !== 1);
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
