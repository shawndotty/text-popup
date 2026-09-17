import { App, Modal, setIcon } from 'obsidian';
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
 * 文字放大弹窗。
 *
 * - 用 Obsidian 自带的 Modal，免费获得 Esc 关闭、点击遮罩关闭、关闭按钮与焦点陷阱。
 * - 尺寸铺满 Obsidian 应用窗口（与内置图片 lightbox 同一思路），便于演示时凸显重点。
 * - 标题栏显示来源笔记名，便于溯源。
 * - 底部控制条提供字号与缩放；只影响本次弹窗，不写回设置。
 */
export class TextPopupModal extends Modal {
	private fontSize: number;
	private zoom = DEFAULT_ZOOM;
	private fontSizeValueEl: HTMLElement | null = null;
	private zoomValueEl: HTMLElement | null = null;

	constructor(
		app: App,
		private text: string,
		private settings: TextPopupSettings,
		private sourceName: string,
	) {
		super(app);
		this.fontSize = settings.popupFontSize;
	}

	onOpen(): void {
		this.modalEl.addClass('mod-text-popup');
		this.titleEl.setText(this.sourceName || '放大显示');

		// 空字符串表示跟随主题：此时不设变量，交给 styles.css 的默认值。
		const background = this.settings.popupBackgroundColor;
		if (background) this.modalEl.style.setProperty('--text-popup-bg', background);
		const foreground = this.settings.popupTextColor;
		if (foreground) this.modalEl.style.setProperty('--text-popup-fg', foreground);

		// 文字外面再包一层，方便用 margin: auto 在满屏窗口里居中：
		// 内容短时居中显示，内容长时仍可从头滚动。
		const scrollEl = this.contentEl.createDiv({ cls: 'text-popup-content' });
		scrollEl.createDiv({ cls: 'text-popup-text', text: this.text });

		this.buildControls(this.contentEl);
		this.updateSize();
	}

	onClose(): void {
		this.contentEl.empty();
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
