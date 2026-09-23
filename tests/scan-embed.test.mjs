/**
 * Canvas / Excalidraw 嵌入的放大图标（V119）用例 —— `scanner/inject.ts` 的三条判据。
 *
 * 背景（详见 [[Plan-20260922-194322]]）：这两类嵌入在实时预览里都**没有**核心建的
 * `.embed-actions`（Canvas 是核心的 CanvasEmbed 不调 `addAction()`；Excalidraw 的容器被
 * Excalidraw 插件 `empty()` 清掉了），所以容器由本插件自建。于是「谁该有图标」完全取决于
 * 本文件钉住的三件事：
 *
 *   ① `qualifyEmbed` —— 认不认得出这两类。错一格就会给普通图片自建第二个容器（重复图标，
 *      因为核心对图片是**无条件**建容器的），或漏掉 Canvas；
 *   ② `canMagnifyEmbed` —— 与候选集同源。候选集来自笔记文本（`blocks.ts` 的 `wikiEmbedKind`），
 *      这里的三条祖先守卫与「第四条闸门」分别对应四类「候选集里没有、图标却挂着」的幽灵条目
 *      （Callout 内 / 嵌入笔记内 / 引用行内 / 解析不到目标文件）。第四条**两类各有一条**：
 *      Canvas 要能解析到那个 `.canvas`（`resolveCanvasFile`，V119 起与候选侧同一个入口），
 *      Excalidraw 要开着同名图片回退且找得到同名 SVG/PNG；
 *   ③ `removeEmbedAction` —— 摘的时候连**自建的容器**一起摘。只删按钮会留下一个空
 *      `.embed-actions` 壳（V117 表格踩过的坑，这里有同一条断言）。
 *
 * 本仓库没有能跑真实样式 / 布局的 DOM 环境（见 tests/styles.test.mjs 文件头），所以这里用
 * 最小假元素（`classList` / `getAttribute` / `closest` / `:scope > .x` 查询）而不是 jsdom：
 * 上面三条判据只读这几个成员，断言的是插件自己的逻辑。几何 / 悬停显形 / 真点击留给真机验证。
 *
 * 需要 obsidian 桩（`setIcon` / `MarkdownView`），`modal.ts` 等传递依赖由 tests/stubs/ 覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { MarkdownView } from './stubs/obsidian.mjs';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	canMagnifyEmbed,
	injectEmbedAction,
	qualifyEmbed,
	removeEmbedAction,
} = await jiti.import('../src/scanner/inject.ts');
const { EMBED_ACTIONS_CLASS } = await jiti.import('../src/scanner/shared.ts');

const ACTION_CLASS = 'text-popup-action';

// —— 最小假 DOM：只实现 inject.ts 用到的那几个成员 ——

class FakeClassList {
	constructor(classes = []) {
		this.set = new Set(classes);
	}

	contains(name) {
		return this.set.has(name);
	}
}

class FakeEl {
	constructor({ classes = [], attrs = {}, ancestors = [] } = {}) {
		this.classList = new FakeClassList(classes);
		this.attrs = { ...attrs };
		/** 由近到远的祖先链，供 `closest` 使用（真实 DOM 里由 parentNode 串起来）。 */
		this.ancestors = ancestors;
		this.children = [];
		this.parentNode = null;
	}

	getAttribute(name) {
		return this.attrs[name] ?? null;
	}

	setAttribute(name, value) {
		this.attrs[name] = String(value);
	}

	get firstChild() {
		return this.children[0] ?? null;
	}

	/** 自身 + 祖先里第一个命中复合类选择器（`.a.b`）的元素。 */
	closest(selector) {
		const classes = selector
			.split('.')
			.filter(Boolean)
			.map((part) => part.replace(/:.*$/, ''));
		for (const el of [this, ...this.ancestors]) {
			if (classes.every((name) => el.classList.contains(name))) return el;
		}
		return null;
	}

	/** 只支持 `:scope > .x`（直接子节点）与 `.x`（任意后代）两种形态 —— inject.ts 只用这两种。 */
	querySelector(selector) {
		const direct = selector.startsWith(':scope > ');
		const cls = (direct ? selector.slice(':scope > '.length) : selector).replace(/^\./, '');
		if (direct) return this.children.find((el) => el.classList.contains(cls)) ?? null;
		const walk = (el) => {
			for (const child of el.children) {
				if (child.classList.contains(cls)) return child;
				const hit = walk(child);
				if (hit) return hit;
			}
			return null;
		};
		return walk(this);
	}

	/** Obsidian 的 `Node.createDiv` 既吃字符串类名也吃 `{ cls }`。 */
	createDiv(arg = '') {
		const cls = typeof arg === 'string' ? arg : (arg.cls ?? '');
		const el = new FakeEl({ classes: String(cls).split(/\s+/).filter(Boolean) });
		return this.appendChild(el);
	}

	appendChild(el) {
		el.parentNode = this;
		this.children.push(el);
		return el;
	}

	/** 与真实 DOM 同语义：`insertBefore` 一个已经是子节点的元素是**移动**，不是复制。 */
	insertBefore(el, ref) {
		this.children = this.children.filter((child) => child !== el);
		el.parentNode = this;
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(el);
		else this.children.splice(at, 0, el);
		return el;
	}

	/** `containingMarkdownView` 用 `view.containerEl.contains(el)` 判归属。 */
	contains(node) {
		for (let cur = node; cur; cur = cur.parentNode) {
			if (cur === this) return true;
		}
		return false;
	}

	remove() {
		this.removed = true;
		const parent = this.parentNode;
		if (parent) parent.children = parent.children.filter((el) => el !== this);
		this.parentNode = null;
	}

	addEventListener() {}
}

/** 假 app：`containingMarkdownView` 读 `workspace.getLeavesOfType`，`resolveExcalidrawImage` 读 `metadataCache`。 */
function makeApp({ files = {}, leaves = [] } = {}) {
	return {
		metadataCache: {
			getFirstLinkpathDest: (linkpath) => files[linkpath] ?? null,
		},
		workspace: { getLeavesOfType: () => leaves },
	};
}

function makeHost({ app = makeApp(), settings = {} } = {}) {
	return {
		app,
		settings: {
			blockKinds: { code: true, callout: true, math: true, image: true, quote: true, table: true },
			excalidrawImageFallback: true,
			excalidrawPreferredFormat: 'svg',
			...settings,
		},
		register() {},
		registerEvent() {},
		registerEditorExtension() {},
	};
}

/** 嵌入容器：`classes` 是容器自身的类名，`attrs` 至少要给 `src`。 */
function makeEmbed({ classes, attrs = {}, ancestors = [] } = {}) {
	return new FakeEl({ classes, attrs, ancestors });
}

// —— ① qualifyEmbed：认不认得出这两类 ——

test('qualifyEmbed 只认 canvas-embed 与 src 指向 Excalidraw 的 image-embed', () => {
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'canvas-embed', 'inline-embed'] })), 'canvas');
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'image-embed'], attrs: { src: 'a.excalidraw' } })), 'excalidraw');
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'image-embed'], attrs: { src: 'a.excalidraw.md' } })), 'excalidraw');
});

test('qualifyEmbed 对普通图片（含无 src）返回 null —— 否则会给核心已建容器的图片造出第二个图标', () => {
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'media-embed', 'image-embed'], attrs: { src: 'a.png' } })), null);
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'image-embed'] })), null);
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed'] })), null);
});

test('qualifyEmbed 认得出带 #^blockref 子路径的 Excalidraw src（这就是不用属性选择器的原因）', () => {
	assert.equal(qualifyEmbed(makeEmbed({ classes: ['internal-embed', 'image-embed'], attrs: { src: 'a.excalidraw#^abc' } })), 'excalidraw');
});

// —— ② canMagnifyEmbed：与候选集同源的四条闸门 ——

test('canMagnifyEmbed 否决「候选集里没有它」的三种位置：嵌入笔记内 / 引用行内 / 别的可放大区块内', () => {
	// 对照组要能解析到文件：canvas 的第四条闸门就是「解析得到才放行」（见下面两条），
	// 用一个解析不到的 canvas 做对照组会把两件事混在一起。
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	view.containerEl = containerEl;
	const app = makeApp({ files: { 'board.canvas': { path: 'board.canvas' } }, leaves: [{ view }] });
	const host = makeHost({ app });
	const canvas = () => {
		const el = makeEmbed({ classes: ['canvas-embed'], attrs: { src: 'board.canvas' } });
		containerEl.appendChild(el);
		return el;
	};
	const context = (selectorClasses) => {
		const el = canvas();
		el.ancestors = [new FakeEl({ classes: selectorClasses })];
		return { host, el };
	};

	const cases = [
		{ name: '嵌入笔记内', ...context(['markdown-embed']) },
		{ name: '引用行内', ...context(['cm-line', 'HyperMD-quote']) },
		{ name: 'Callout 等 .cm-embed-block 内（外层区块已有自己的图标）', ...context(['cm-embed-block', 'cm-callout']) },
	];
	for (const entry of cases) {
		assert.equal(canMagnifyEmbed(entry.el, entry.host, 'canvas'), false, entry.name);
	}
	assert.equal(canMagnifyEmbed(canvas(), host, 'canvas'), true, '对照组：干净且能解析到文件的 canvas 应当放行');
});

test('canMagnifyEmbed（canvas）与候选集同源：解析不到画布文件时必须为 false', () => {
	// 候选侧（session.ts 的 canvas 分支）解析不到文件时会丢掉整条候选，图标必须同步消失 ——
	// 否则就是「有图标却点不开」的死图标。判据走同一个 resolveCanvasFile。
	assert.equal(
		canMagnifyEmbed(makeEmbed({ classes: ['canvas-embed'] }), makeHost(), 'canvas'),
		false,
		'没有 src',
	);
	assert.equal(
		canMagnifyEmbed(
			makeEmbed({ classes: ['canvas-embed'], attrs: { src: 'missing.canvas' } }),
			makeHost(),
			'canvas',
		),
		false,
		'src 指向的画布在 vault 里找不到（metadataCache 返回 null）',
	);
});

test('canMagnifyEmbed（canvas）不吃 Excalidraw 的「同名图片回退」闸门', () => {
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	const el = makeEmbed({ classes: ['canvas-embed'], attrs: { src: 'board.canvas' } });
	containerEl.appendChild(el);
	view.containerEl = containerEl;
	const app = makeApp({
		files: { 'board.canvas': { path: '4-成果/board.canvas' } },
		leaves: [{ view }],
	});
	assert.equal(
		canMagnifyEmbed(el, makeHost({ app, settings: { excalidrawImageFallback: false } }), 'canvas'),
		true,
		'画布解析得到就放行 —— 与 Excalidraw 那套回退设置无关',
	);
});

test('canMagnifyEmbed（excalidraw）与候选集同源：回退关闭 / 同名图片找不到时都必须为 false', () => {
	const el = () => makeEmbed({ classes: ['internal-embed', 'image-embed'], attrs: { src: 'a.excalidraw' } });

	assert.equal(canMagnifyEmbed(el(), makeHost({ settings: { excalidrawImageFallback: false } }), 'excalidraw'), false, '回退关闭');
	assert.equal(canMagnifyEmbed(el(), makeHost(), 'excalidraw'), false, '同名图片找不到（createCandidate 会丢掉这条候选）');
});

test('canMagnifyEmbed（excalidraw）在同名图片存在且所在笔记已知时放行', () => {
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	const el = makeEmbed({ classes: ['internal-embed', 'image-embed'], attrs: { src: 'a.excalidraw' } });
	containerEl.appendChild(el);
	view.containerEl = containerEl;

	const app = makeApp({
		files: { 'a.excalidraw.svg': { path: '4-成果/a.excalidraw.svg' } },
		leaves: [{ view }],
	});
	assert.equal(canMagnifyEmbed(el, makeHost({ app }), 'excalidraw'), true);

	// 按首选格式解析：png 优先时同名 svg 仍可回退命中（与 resolveExcalidrawImage 的兜底一致）
	assert.equal(
		canMagnifyEmbed(el, makeHost({ app, settings: { excalidrawPreferredFormat: 'png' } }), 'excalidraw'),
		true,
	);
});

// —— ③ 注入 / 摘除：连自建容器一起摘、幂等 ——

test('removeEmbedAction 连自建的 text-popup-embed-actions 容器一起摘（只删按钮会留空壳）', () => {
	const embedEl = makeEmbed({ classes: ['canvas-embed'] });
	const actionsEl = embedEl.createDiv(`${EMBED_ACTIONS_CLASS} embed-actions`);
	actionsEl.createDiv(`${ACTION_CLASS} interactive-child embed-action`);

	removeEmbedAction(embedEl);

	assert.equal(embedEl.children.length, 0, '容器必须一起移除，否则会留下一个空的 .embed-actions 壳');
});

test('injectEmbedAction 写进自建容器且可重复调用（幂等，重渲染补回不会叠加）', () => {
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	const embedEl = makeEmbed({ classes: ['canvas-embed'], attrs: { src: 'board.canvas' } });
	containerEl.appendChild(embedEl);
	view.containerEl = containerEl;
	const app = makeApp({
		files: { 'board.canvas': { path: 'board.canvas' } },
		leaves: [{ view }],
	});
	const host = makeHost({ app });

	injectEmbedAction(embedEl, host, 'canvas');
	injectEmbedAction(embedEl, host, 'canvas');

	const actionsEl = embedEl.querySelector(`:scope > .${EMBED_ACTIONS_CLASS}`);
	assert.ok(actionsEl, '应当建出自建容器');
	assert.ok(actionsEl.classList.contains('embed-actions'), '容器必须同时带 embed-actions（白拿核心皮肤与定位）');
	assert.equal(actionsEl.children.length, 1, '重复调用不得叠加第二个按钮');
	assert.equal(embedEl.children.length, 1, '不得叠加第二个容器');
});

test('injectEmbedAction 在 Canvas 解析不到文件时自行摘除已注入的图标（与候选集同源，不留死图标）', () => {
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	const embedEl = makeEmbed({ classes: ['canvas-embed'], attrs: { src: 'board.canvas' } });
	containerEl.appendChild(embedEl);
	view.containerEl = containerEl;

	const found = makeApp({
		files: { 'board.canvas': { path: 'board.canvas' } },
		leaves: [{ view }],
	});
	injectEmbedAction(embedEl, makeHost({ app: found }), 'canvas');
	assert.equal(embedEl.children.length, 1, '画布在 vault 里 → 应当有图标');

	// 画布被删掉 / 改名后：候选会被丢掉，图标必须同步消失
	injectEmbedAction(embedEl, makeHost({ app: makeApp({ leaves: [{ view }] }) }), 'canvas');
	assert.equal(embedEl.children.length, 0, '解析不到画布文件时已注入的图标必须同步消失');
});

test('injectEmbedAction 在闸门关掉后自行摘除已注入的图标（不必等下一次全量扫描）', () => {
	const view = new MarkdownView();
	const containerEl = new FakeEl();
	const embedEl = makeEmbed({
		classes: ['internal-embed', 'image-embed'],
		attrs: { src: 'a.excalidraw' },
	});
	containerEl.appendChild(embedEl);
	view.containerEl = containerEl;
	const app = makeApp({
		files: { 'a.excalidraw.svg': { path: 'a.excalidraw.svg' } },
		leaves: [{ view }],
	});

	injectEmbedAction(embedEl, makeHost({ app }), 'excalidraw');
	assert.equal(embedEl.children.length, 1, '同名图片在 → 应当有图标');

	injectEmbedAction(embedEl, makeHost({ app, settings: { excalidrawImageFallback: false } }), 'excalidraw');
	assert.equal(embedEl.children.length, 0, '闸门关掉后已注入的图标必须同步消失');
});
