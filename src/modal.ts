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

		this.buildControls(this.contentEl);
		this.updateSize();

		this.show(this.index);
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
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
				if (textEl.textContent?.trim() || textEl.childElementCount > 0) return;
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
		buttonEl.addEventListener('keydown', (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
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
		this.updateSize();
	}

	/** 缩放以倍数作用于字号，因此内容始终自然重排，不会出现被裁切的情况。 */
	private updateSize(): void {
		const effectiveSize = Math.round(this.fontSize * this.zoom);
		this.modalEl.style.setProperty('--text-popup-font-size', `${effectiveSize}px`);
		// mermaid 是矢量图：字号 / 缩放都换算成「整图缩放比」，1 = 铺满弹窗宽度
		this.modalEl.style.setProperty(
			'--text-popup-mermaid-scale',
			String(effectiveSize / this.settings.popupFontSize),
		);
		this.fontSizeValueEl?.setText(`${this.fontSize} px`);
		this.zoomValueEl?.setText(`${Math.round(this.zoom * 100)}%`);
	}
}
