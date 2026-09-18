// obsidian 依赖只提供 .d.ts（package.json 的 "main" 是空串），没有运行时代码。
// 这里给出单测所需的最小可导入实现，**只替 Obsidian 边界，不模拟 Obsidian 行为**：
// 桩里的函数一律不做真实渲染 / 布局 / 事件，测试断言的都是插件自己的纯逻辑。
//
// 必须放在插件目录内（不能放仓库外的共享目录）：`moment` 是从这里重导出的，
// 模块解析基准在插件目录时才能命中 node_modules/moment。

// Obsidian 运行环境始终存在 window 全局；补一个最小实现，
// 让源码里按 lint 规则写的 window.setTimeout 等在 Node 测试里也能运行。
if (typeof globalThis.window === 'undefined') {
	globalThis.window = globalThis;
}

// 重导出**真实** moment：`lang/helpers.ts` 读 moment.locale() 选词典，
// 用假 moment 会掩盖 zh-hant / zh-hk 这类真实语言变体的行为。
import moment from 'moment';

export { moment };

/** settings.ts / scanner.ts 用到的空壳；除下方的 `Modal` 外，测试只赋值、不 new。 */
export class App {}

export class Component {
	addChild(child) {
		return child;
	}

	removeChild() {}
}

export class MarkdownView {}

export class Plugin {}

/**
 * `Show Popup In The Note` 命令会 `new TextPopupModal(...).open()`，所以这个壳要能被 new。
 * `open()` 按顺序记进模块级 `modals`（与 `notices` 同一手法）：**不模拟 Obsidian 行为**，
 * 只让用例能断言「弹窗开没开、开在哪一条」。`onOpen` 不触发，因此不会碰任何 DOM。
 */
export const modals = [];

export class Modal {
	open() {
		modals.push(this);
	}
}

export class PluginSettingTab {}

export class Setting {}

export class Menu {}

export class TAbstractFile {}

export class TFile {}

export class TFolder {}

/**
 * commands.ts 用它提示用户。除实例上的 `message` 外，还按顺序记进模块级 `notices`：
 * 命令层是 `void` 函数，提示文案是它唯一的可观测输出，用例靠这个数组断言文案与「有没有提示」。
 */
export const notices = [];

export class Notice {
	constructor(message) {
		this.message = message;
		notices.push(message);
	}
}

/** modal.ts / scanner.ts 的渲染边界，测试不触发真实渲染。 */
export const MarkdownRenderer = {
	render: async () => {},
	renderMarkdown: async () => {},
};

export const Platform = { isMobile: false };

export function debounce(fn) {
	let timer = null;
	const wrapped = (...args) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, 0);
	};
	wrapped.cancel = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return wrapped;
}

export function setIcon() {}

export function sanitizeHTMLToDom() {
	return { childNodes: [], appendChild() {} };
}
