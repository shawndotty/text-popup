import { App, Component, MarkdownRenderer, Modal, setIcon } from 'obsidian';
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
 * 打开弹窗所需的全部入参，由 scanner 组装。
 *
 * 用单个对象承载四个相近的字符串（而不是四个平铺参数），避免调用处错位。
 */
export interface TextPopupPayload {
	/** 纯文本内容（extractText），回退路径使用。 */
	plain: string;
	/** 富文本输入（extractRichSource），可能为空字符串。 */
	rich: string;
	/** 标题栏显示的笔记名。 */
	sourceName: string;
	/** 链接 / 嵌入的解析基准：笔记完整路径（TFile.path），不能用 basename。 */
	sourcePath: string;
}

/**
 * 文字放大弹窗。
 *
 * - 用 Obsidian 自带的 Modal，免费获得 Esc 关闭、点击遮罩关闭、关闭按钮与焦点陷阱。
 * - 尺寸铺满 Obsidian 应用窗口（与内置图片 lightbox 同一思路），便于演示时凸显重点。
 * - 标题栏显示来源笔记名，便于溯源。
 * - 底部控制条提供字号与缩放；只影响本次弹窗，不写回设置。
 * - 内容默认交给 MarkdownRenderer 渲染 HTML 与 Markdown，失败时回退纯文本。
 */
export class TextPopupModal extends Modal {
	/** MarkdownRenderer 要求传入真实 Component，并在关闭时卸载，避免嵌入内容的事件监听泄漏。 */
	private component = new Component();
	private fontSize: number;
	private zoom = DEFAULT_ZOOM;
	private fontSizeValueEl: HTMLElement | null = null;
	private zoomValueEl: HTMLElement | null = null;

	constructor(
		app: App,
		private payload: TextPopupPayload,
		private settings: TextPopupSettings,
	) {
		super(app);
		this.fontSize = settings.popupFontSize;
	}

	onOpen(): void {
		this.modalEl.addClass('mod-text-popup');
		this.titleEl.setText(this.payload.sourceName || '放大显示');

		// 空字符串表示跟随主题：此时不设变量，交给 styles.css 的默认值。
		const background = this.settings.popupBackgroundColor;
		if (background) this.modalEl.style.setProperty('--text-popup-bg', background);
		const foreground = this.settings.popupTextColor;
		if (foreground) this.modalEl.style.setProperty('--text-popup-fg', foreground);

		// 必须在 render 之前 load：渲染出的子组件会挂在它下面。
		this.component.load();

		// 文字外面再包一层，方便用 margin: auto 在满屏窗口里居中：
		// 内容短时居中显示，内容长时仍可从头滚动。
		const scrollEl = this.contentEl.createDiv({ cls: 'text-popup-content' });
		const textEl = scrollEl.createDiv({ cls: 'text-popup-text' });

		this.buildControls(this.contentEl);
		this.updateSize();

		void this.renderBody(textEl);
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}

	/** 优先富文本渲染；产出为空或抛错时回退纯文本，保证弹窗永不空白。 */
	private async renderBody(textEl: HTMLElement): Promise<void> {
		if (this.settings.renderRichText && this.payload.rich) {
			textEl.addClass('markdown-rendered', 'is-rich');
			try {
				// render 是 append 语义，这里容器刚建好为空，不存在重复追加。
				await MarkdownRenderer.render(
					this.app,
					this.payload.rich,
					textEl,
					this.payload.sourcePath,
					this.component,
				);
				// 判据用「有文本 或 有子元素」，覆盖「只渲染出一张图片、没有文字」的情况。
				if (textEl.textContent?.trim() || textEl.childElementCount > 0) return;
			} catch (error) {
				console.error('[text-popup] 富文本渲染失败，已回退为纯文本', error);
			}
			textEl.empty();
			textEl.removeClass('markdown-rendered', 'is-rich');
		}
		textEl.addClass('is-plain');
		textEl.setText(this.payload.plain);
	}

	private buildControls(parentEl: HTMLElement): void {
		const controlsEl = parentEl.createDiv({ cls: 'text-popup-controls' });

		const fontGroupEl = controlsEl.createDiv({ cls: 'text-popup-control-group' });
		fontGroupEl.createSpan({ cls: 'text-popup-control-label', text: '字号' });
		this.createControlButton(fontGroupEl, 'minus', '减小字号', () => this.stepFontSize(-1));
		this.fontSizeValueEl = fontGroupEl.createSpan({ cls: 'text-popup-control-value' });
		this.createControlButton(fontGroupEl, 'plus', '增大字号', () => this.stepFontSize(1));

		const zoomGroupEl = controlsEl.createDiv({ cls: 'text-popup-control-group' });
		zoomGroupEl.createSpan({ cls: 'text-popup-control-label', text: '缩放' });
		this.createControlButton(zoomGroupEl, 'zoom-out', '整体缩小', () => this.stepZoom(-1));
		this.zoomValueEl = zoomGroupEl.createSpan({ cls: 'text-popup-control-value' });
		this.createControlButton(zoomGroupEl, 'zoom-in', '整体放大', () => this.stepZoom(1));

		this.createControlButton(controlsEl, 'rotate-ccw', '恢复默认', () => this.resetSize());
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
		this.fontSizeValueEl?.setText(`${this.fontSize} px`);
		this.zoomValueEl?.setText(`${Math.round(this.zoom * 100)}%`);
	}
}
