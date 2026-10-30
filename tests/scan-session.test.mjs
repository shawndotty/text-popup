/**
 * `embeddedAnchor()` 的契约 + `createTextPopupSource` 的取值顺序（V130）。
 *
 * 背景（详见 [[Research-20261031-061126]] §四·R3 与 [[Plan-20261031-063656]]）：IOTO Task View 的
 * 卡片正文是内嵌编辑器（`TextFileView` 子类），既不在 `getLeavesOfType('markdown')` 里、
 * `getActiveViewOfType(MarkdownView)` 也取不到它 —— 旧实现因此拿到 `editor = null`、候选集空、
 * 弹窗静默不开。V130 补的第三条路径是「从 `workspace.activeEditor` 认领内嵌编辑器」。
 *
 * 这个文件的断言分两层，缺一不可：
 * 1. **助手契约**（`embeddedAnchor`）：`activeEditor` 可能指向**别的窗格**，所以「点必须落在它的
 *    宿主元素里」是硬判据。只测「能认出来」而不测「点不在里面时必须拒绝」，等于把 R3 的另一半
 *    （弹窗打开了但内容是别的笔记）放出去了 —— 那比「不弹窗」更难发现。
 * 2. **端到端取值顺序**（`createTextPopupSource`）：三条路径的优先级与短路。尤其是「内嵌命中后
 *    不能再走近似兜底」，顺序写反了会静默拿错笔记。
 *
 * 本仓库没有能跑真实布局的 DOM 环境（见 tests/styles.test.mjs 文件头），假元素只实现被读到的
 * 那几个成员（`contains` / `closest` / `classList`），不做布局；真点击与几何留给真机验收。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { MarkdownView } from './stubs/obsidian.mjs';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const { embeddedAnchor } = await jiti.import('../src/scanner/shared.ts');
const { createTextPopupSource } = await jiti.import('../src/scanner/session.ts');

// —— 最小假 DOM ——

class FakeClassList {
	constructor(classes = []) {
		this.set = new Set(classes);
	}

	contains(name) {
		return this.set.has(name);
	}
}

class FakeEl {
	constructor({ classes = [] } = {}) {
		this.classList = new FakeClassList(classes);
		this.parentNode = null;
	}

	appendChild(el) {
		el.parentNode = this;
		return el;
	}

	/** 与真实 DOM 同语义：自身 + 祖先里第一个命中复合类选择器（`.a.b`）的元素。 */
	closest(selector) {
		const classes = selector
			.split('.')
			.filter(Boolean)
			.map((part) => part.replace(/:.*$/, ''));
		for (let cur = this; cur; cur = cur.parentNode) {
			if (classes.every((name) => cur.classList.contains(name))) return cur;
		}
		return null;
	}

	/** 真实 DOM 的 `contains` 含自身；`embeddedAnchor` / `containingMarkdownView` 都靠它判归属。 */
	contains(node) {
		for (let cur = node; cur; cur = cur.parentNode) {
			if (cur === this) return true;
		}
		return false;
	}
}

/**
 * 假 Editor：只实现 `createTextPopupSource` 这条链读到的成员（`getValue` / `cm.posAtDOM` /
 * `offsetToPos`）。`cm.dom` 是 `embeddedAnchor` 在宿主没给 `containerEl` 时的退路。
 */
function makeEditor({ text = '', hostEl = null, posAtDOM = () => 0 } = {}) {
	const calls = { posAtDOM: 0 };
	const cm = {
		posAtDOM(node, offset) {
			calls.posAtDOM += 1;
			return posAtDOM(node, offset);
		},
	};
	if (hostEl) cm.dom = hostEl;
	return {
		editor: {
			getValue: () => text,
			cm,
			// 单行文本：偏移量即行内字符位置（本文件只用单行文档）
			offsetToPos: (offset) => ({ line: 0, ch: offset }),
		},
		calls,
	};
}

/** 假 workspace：三条取值路径各自的可观测入口。 */
function makeApp({ leaves = [], activeEditor = null, activeView = null, activeFile = null } = {}) {
	return {
		workspace: {
			getLeavesOfType: () => leaves,
			getActiveViewOfType: () => activeView,
			getActiveFile: () => activeFile,
			activeEditor,
		},
		metadataCache: { getFirstLinkpathDest: () => null },
	};
}

function makeHost(app) {
	return {
		app,
		settings: {
			blockKinds: { code: true, callout: true, math: true, image: true, quote: true, table: true },
			renderRichText: false,
			excalidrawImageFallback: false,
		},
		register() {},
		registerEvent() {},
		registerEditorExtension() {},
	};
}

/**
 * 卡片里的那块图片：`![[…]]` 单行，与真机待验卡片的第一条同形。
 * 三块版本用来证明 `locateStartIndex` 在内嵌编辑器下真的定位到「被点的那一块」。
 */
const ONE_IMAGE = '![[Pasted image 20261031052209.png]]';
const THREE_IMAGES = [
	'![[a.png]]',
	'![[b.png]]',
	'![[c.png]]',
].join('\n');

const TASK_FILE = { path: '3-任务/IOTO Task Center/Text Popup插件的支持.md', basename: 'Text Popup插件的支持' };

// —— ① embeddedAnchor 契约 ——

test('embeddedAnchor：containerEl 包含点击点 → 认领（editor / file / containerEl 都对）', () => {
	const hostEl = new FakeEl();
	const actionEl = hostEl.appendChild(new FakeEl());
	const { editor } = makeEditor({ hostEl: new FakeEl() });
	const app = makeApp({ activeEditor: { editor, file: TASK_FILE, containerEl: hostEl } });

	const anchor = embeddedAnchor(app, actionEl);

	assert.ok(anchor, '点落在宿主里应当认领');
	assert.equal(anchor.editor, editor);
	assert.equal(anchor.file, TASK_FILE, 'sourcePath 取自这个 file —— 弹窗标题显示的就是任务笔记名');
	assert.equal(anchor.containerEl, hostEl);
});

test('embeddedAnchor：宿主没给 containerEl 时退回 editor.cm.dom（向后兼容）', () => {
	const cmDom = new FakeEl();
	const actionEl = cmDom.appendChild(new FakeEl());
	const { editor } = makeEditor({ hostEl: cmDom });
	// 刻意不带 containerEl：Research §五 实测 F1 批次之前它就是 undefined
	const app = makeApp({ activeEditor: { editor, file: TASK_FILE } });

	const anchor = embeddedAnchor(app, actionEl);

	assert.ok(anchor, '有 cm.dom 就仍要能认领 —— 依赖宿主补 containerEl 才生效是不可接受的');
	assert.equal(anchor.containerEl, cmDom);
});

test('embeddedAnchor：点不在活动编辑器里 → null（不许把别的窗格的笔记当成这张卡片）', () => {
	const hostEl = new FakeEl();
	const elsewhere = new FakeEl();
	const { editor } = makeEditor({ hostEl });
	const app = makeApp({ activeEditor: { editor, file: TASK_FILE, containerEl: hostEl } });

	assert.equal(embeddedAnchor(app, elsewhere), null, 'activeEditor 可能是另一个窗格，必须拒绝');
});

test('embeddedAnchor：activeEditor 为 null → null', () => {
	assert.equal(embeddedAnchor(makeApp(), new FakeEl()), null);
});

test('embeddedAnchor：activeEditor 没有 editor（只有 file）→ null', () => {
	const app = makeApp({ activeEditor: { file: TASK_FILE } });
	assert.equal(embeddedAnchor(app, new FakeEl()), null);
});

// —— ② createTextPopupSource 的取值顺序 ——

test('卡片编辑态：从 activeEditor 认领 editor，候选集与起点都对（R3 的主用例）', () => {
	const hostEl = new FakeEl();
	const actionEl = hostEl.appendChild(new FakeEl());
	const { editor, calls } = makeEditor({ text: ONE_IMAGE, hostEl });
	const app = makeApp({
		// 卡片是 TextFileView 子类：没有 markdown 叶子，活动视图也不是 MarkdownView
		leaves: [],
		activeView: null,
		activeEditor: { editor, file: TASK_FILE, containerEl: hostEl },
		activeFile: null,
	});

	const { source, startIndex } = createTextPopupSource(makeHost(app), actionEl);

	assert.equal(source.size, 1, '卡片里就这一块 → 候选 1 条（旧实现是 0 条，弹窗静默不开）');
	assert.ok(source.read(0), 'read(0) 不能是 null —— 它是「空块不弹窗」那条守卫的判据');
	assert.equal(startIndex, 0);
	assert.equal(calls.posAtDOM, 1, '必须真的走过 locateStartIndex，而不是「editor 为 null 时的 0」蒙对');
	assert.equal(source.sourceName, 'Text Popup插件的支持', '弹窗标题的文件名来自内嵌编辑器的 file');
	assert.equal(source.sourcePath, TASK_FILE.path, '解析相对链接的基准也是任务笔记的完整路径');
});

test('卡片里多块时，起点跟着被点的那一块走（不是恒 0、也不是 −1）', () => {
	const hostEl = new FakeEl();
	const actionEl = hostEl.appendChild(new FakeEl());
	// 被点的是第三块：posAtDOM 把它映射回文档里 `![[c.png]]` 的起始偏移
	const offsetToThird = THREE_IMAGES.indexOf('![[c.png]]');
	const { editor } = makeEditor({ text: THREE_IMAGES, hostEl, posAtDOM: () => offsetToThird });
	// 多行文档：偏移量 → 行列（与本文件其它用例的单行版本不同）
	editor.offsetToPos = (offset) => {
		const before = THREE_IMAGES.slice(0, offset).split('\n');
		return { line: before.length - 1, ch: before[before.length - 1].length };
	};
	const app = makeApp({
		leaves: [],
		activeView: null,
		activeEditor: { editor, file: TASK_FILE, containerEl: hostEl },
	});

	const { source, startIndex } = createTextPopupSource(makeHost(app), actionEl);

	assert.equal(source.size, 3);
	assert.equal(startIndex, 2, '起点应当是第 3 块 —— 恒 0 会让每一块都翻出第一块');
});

test('点不在活动编辑器里且没有 markdown 叶子 → 候选 0 条（宁可不弹，也不拿错笔记）', () => {
	const hostEl = new FakeEl();
	const elsewhere = new FakeEl();
	const { editor } = makeEditor({ text: ONE_IMAGE, hostEl });
	const app = makeApp({
		leaves: [],
		activeView: null,
		activeEditor: { editor, file: TASK_FILE, containerEl: hostEl },
	});

	const { source } = createTextPopupSource(makeHost(app), elsewhere);

	assert.equal(source.size, 0, '认领失败时必须退回「没有候选」，不能悄悄用了别的窗格的正文');
	assert.equal(source.read(0), null);
});

test('MarkdownView 优先：真笔记与内嵌编辑器都包含该元素时，取笔记那一份', () => {
	// 真机上两者不会同时成立（`activeEditor` 也指向那个笔记的编辑器时 view 先命中），
	// 这里刻意造两个「都包含」的宿主来锁优先级；因此只实现 `contains`，不串 parentNode。
	const contained = { contains: () => true };
	const actionEl = new FakeEl();

	const view = new MarkdownView();
	view.containerEl = contained;
	const noteEditor = makeEditor({ text: '```js\nconst a = 1;\n```' });
	const noteFile = { path: '2-输出/笔记.md', basename: '笔记' };
	view.editor = noteEditor.editor;
	view.file = noteFile;

	const embeddedEditor = makeEditor({ text: ONE_IMAGE, hostEl: contained });

	const app = makeApp({
		leaves: [{ view }],
		activeView: view,
		activeEditor: { editor: embeddedEditor.editor, file: TASK_FILE, containerEl: contained },
	});

	const { source, startIndex } = createTextPopupSource(makeHost(app), actionEl);

	assert.equal(source.sourceName, '笔记', '内嵌路径不得抢走正常笔记');
	assert.equal(source.size, 1);
	assert.equal(source.read(0)?.plain.includes('const a = 1'), true, '内容必须是笔记里的代码块');
	assert.equal(startIndex, 0);
});
