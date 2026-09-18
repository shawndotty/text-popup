/**
 * `commands.ts` 的行为用例 —— 两个转换命令的守卫与写回。
 *
 * 这一层最容易出「静默改坏用户的笔记」的事故，所以断言分两类：
 * 1. 正常路径：写回的内容逐字节比对；
 * 2. 守卫路径：**必须一个字节都不改**，且给出 Notice。守卫用例统一用
 *    `expectRejected()` 断言「文档未变 + 有提示 + 提示文案等于 `t(...)`」。
 *
 * Notice 文案用 `t('...')` 取值而不是硬编码英文：V106 刚上多语言，硬编码会让用例
 * 在切语言时假绿（文案变了、断言还按英文过）。
 *
 * 需要 obsidian 桩（`Notice`）+ 假 Editor。假 Editor 只实现 commands.ts 用到的那几个成员
 * （见下方 `createEditor`），不引入真实 CodeMirror。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { notices } from './stubs/obsidian.mjs';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const { registerCommands } = await jiti.import('../src/commands.ts');
const { normalizeSettings } = await jiti.import('../src/settings.ts');
const { t } = await jiti.import('../src/lang/helpers.ts');

const POPUP = 'popup-selected-text';
const UNPOPUP = 'unpopup-selected-text';

/** 假 Editor：以整篇字符串为文档，行/列与偏移量互转。只实现 commands.ts 用到的成员。 */
function createEditor(text, options = {}) {
	let doc = text;
	const splitLines = () => doc.split('\n');
	const posToOffset = (pos) => {
		const lines = splitLines();
		let offset = 0;
		for (let line = 0; line < pos.line; line++) offset += (lines[line] ?? '').length + 1;
		return offset + pos.ch;
	};
	const offsetToPos = (offset) => {
		const lines = splitLines();
		let acc = 0;
		for (let line = 0; line < lines.length; line++) {
			const length = (lines[line] ?? '').length;
			if (offset <= acc + length) return { line, ch: offset - acc };
			acc += length + 1;
		}
		const last = lines.length - 1;
		return { line: last, ch: (lines[last] ?? '').length };
	};

	const selections = options.selections ?? [
		{
			from: options.from ?? { line: 0, ch: 0 },
			to: options.to ?? offsetToPos(doc.length),
		},
	];

	return {
		getValue: () => doc,
		getLine: (line) => splitLines()[line] ?? '',
		lastLine: () => splitLines().length - 1,
		getCursor: (which) => (which === 'to' ? selections[0].to : selections[0].from),
		listSelections: () => selections,
		somethingSelected: () => selections.some((s) => posToOffset(s.from) !== posToOffset(s.to)),
		getRange: (from, to) => doc.slice(posToOffset(from), posToOffset(to)),
		replaceRange: (replacement, from, to) => {
			doc = doc.slice(0, posToOffset(from)) + replacement + doc.slice(posToOffset(to));
		},
		offsetToPos,
	};
}

/** 选区覆盖 fromLine–toLine 整行（含行尾字符）。 */
function selectLines(text, fromLine, toLine) {
	const lines = text.split('\n');
	return { from: { line: fromLine, ch: 0 }, to: { line: toLine, ch: (lines[toLine] ?? '').length } };
}

/** 假宿主：捕获命令、事件与 App。 */
function createHost(settings = {}) {
	const app = {
		workspace: {
			on: (type, handler) => {
				app.handlers[type] = handler;
				return { type };
			},
		},
		handlers: {},
	};
	const host = {
		app,
		settings: normalizeSettings(settings),
		commands: [],
		events: [],
		addCommand(command) {
			host.commands.push(command);
			return command;
		},
		registerEvent(ref) {
			host.events.push(ref);
		},
	};
	return host;
}

function runCommand(host, id, editor, checking = false) {
	const command = host.commands.find((item) => item.id === id);
	assert.ok(command, `命令未注册: ${id}`);
	notices.length = 0;
	return command.editorCheckCallback(checking, editor);
}

/** 守卫路径的统一断言：文档逐字节未变 + 有且只有一条提示 + 文案正确。 */
function expectRejected(host, id, editor, expectedText) {
	const before = editor.getValue();
	notices.length = 0;
	host.commands.find((item) => item.id === id).editorCheckCallback(false, editor);
	assert.equal(editor.getValue(), before, '守卫命中时不该改动一个字节');
	assert.deepEqual([...notices], [expectedText], '提示文案应为 t(...) 的当前语言取值');
}

// —— 注册 ——

test('恰好注册两个命令，id 与图标稳定', () => {
	const host = createHost();
	registerCommands(host);
	assert.deepEqual(
		host.commands.map((command) => command.id),
		[POPUP, UNPOPUP],
	);
	assert.equal(host.commands[0].icon, 'maximize-2', 'popup 图标');
	assert.equal(host.commands[1].icon, 'minimize-2', 'unpopup 图标');
	assert.equal(host.commands[0].name, t('Popup selected text'), 'popup 名称取当前语言');
	assert.equal(host.commands[1].name, t('Unpopup selected text'), 'unpopup 名称取当前语言');
	assert.equal(host.events.length, 1, '右键菜单事件只注册一次');
	assert.equal(typeof host.app.handlers['editor-menu'], 'function', '监听 editor-menu');
});

test('没有选区时命令在面板里灰掉（editorCheckCallback 返回 false）', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('abc', { from: { line: 0, ch: 1 }, to: { line: 0, ch: 1 } });
	assert.equal(runCommand(host, POPUP, editor, true), false, 'popup');
	assert.equal(runCommand(host, UNPOPUP, editor, true), false, 'unpopup');
});

// —— Popup 正常路径 ——

test('Popup 把选中文本写成包裹标签块', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('hello **world**');
	runCommand(host, POPUP, editor);
	assert.equal(editor.getValue(), '<div>\nhello <strong>world</strong>\n</div>');
	assert.deepEqual([...notices], [], '成功路径不该有提示');
});

test('Popup 在闭标签后紧邻非空行时补一个空行', () => {
	const host = createHost();
	registerCommands(host);
	const text = 'hello **world**\nafter';
	const editor = createEditor(text, selectLines(text, 0, 0));
	runCommand(host, POPUP, editor);
	assert.equal(editor.getValue(), '<div>\nhello <strong>world</strong>\n</div>\n\nafter');
});

test('Popup 在文末插入时不补多余的换行', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('hello');
	runCommand(host, POPUP, editor);
	assert.equal(editor.getValue(), '<div>\nhello\n</div>');
});

test('Popup 用设置里的包裹标签', () => {
	const host = createHost({ supportedTags: 'div, p', popupTag: 'p' });
	registerCommands(host);
	const editor = createEditor('hello');
	runCommand(host, POPUP, editor);
	assert.equal(editor.getValue(), '<p>\nhello\n</p>');
});

// —— Popup 守卫 ——

test('多光标时拒绝，且一个字节都不改', () => {
	const host = createHost();
	registerCommands(host);
	const text = 'abc';
	const editor = createEditor(text, {
		selections: [
			{ from: { line: 0, ch: 0 }, to: { line: 0, ch: 1 } },
			{ from: { line: 0, ch: 2 }, to: { line: 0, ch: 3 } },
		],
	});
	expectRejected(host, POPUP, editor, t('Please use a single cursor.'));
});

test('纯空白选区时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('   ');
	expectRejected(host, POPUP, editor, t('The selection is empty; nothing to convert.'));
});

test('缩进过深（4 空格 / 制表符）时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	expectRejected(
		host,
		POPUP,
		createEditor('    indented'),
		t('The selection is indented too deeply and would be treated as a code block.'),
	);
	expectRejected(
		host,
		POPUP,
		createEditor('\tindented'),
		t('The selection is indented too deeply and would be treated as a code block.'),
	);
});

test('选区落在代码块内时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const text = '```js\ncode\n```';
	const editor = createEditor(text, selectLines(text, 1, 1));
	expectRejected(host, POPUP, editor, t('The selection is inside a code block, callout, or math block.'));
});

test('选区落在 Callout 内时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const text = '> [!note]\n> body';
	const editor = createEditor(text, selectLines(text, 1, 1));
	expectRejected(host, POPUP, editor, t('The selection is inside a code block, callout, or math block.'));
});

test('选区落在数学块内时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const text = '$$\na\n$$';
	const editor = createEditor(text, selectLines(text, 1, 1));
	expectRejected(host, POPUP, editor, t('The selection is inside a code block, callout, or math block.'));
});

test('选区落在已有 HTML 块内时提示先 unpopup', () => {
	const host = createHost();
	registerCommands(host);
	const text = '<div>\na\n</div>';
	const editor = createEditor(text, selectLines(text, 1, 1));
	expectRejected(
		host,
		POPUP,
		editor,
		t('The selection already contains a popup block; use the unpopup command first.'),
	);
});

// —— Unpopup ——

test('Unpopup 把块内 HTML 还原成 Markdown', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('<div>a<br>b</div>');
	runCommand(host, UNPOPUP, editor);
	assert.equal(editor.getValue(), 'a\nb');
});

test('Unpopup 只替换 <T>…</T>，块内的用户后文留在原处', () => {
	const host = createHost();
	registerCommands(host);
	const text = '<div>\na\n</div>\nafter';
	const editor = createEditor(text, selectLines(text, 0, 2));
	runCommand(host, UNPOPUP, editor);
	assert.equal(editor.getValue(), 'a\nafter');
});

test('Unpopup 还原行内标记', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('<div>\n<strong>粗</strong> 与 <code>x</code>\n</div>');
	runCommand(host, UNPOPUP, editor);
	assert.equal(editor.getValue(), '**粗** 与 `x`');
});

test('多光标时 Unpopup 同样拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const editor = createEditor('<div>a</div>', {
		selections: [
			{ from: { line: 0, ch: 0 }, to: { line: 0, ch: 3 } },
			{ from: { line: 0, ch: 5 }, to: { line: 0, ch: 8 } },
		],
	});
	expectRejected(host, UNPOPUP, editor, t('Please use a single cursor.'));
});

test('选区里没有可还原的 HTML 块时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	expectRejected(
		host,
		UNPOPUP,
		createEditor('普通段落\nafter'),
		t('The selection is not inside a magnifiable HTML block.'),
	);
});

test('选区跨多个弹窗块时拒绝', () => {
	const host = createHost();
	registerCommands(host);
	const text = '<div>\na\n</div>\n\n<div>\nb\n</div>';
	const editor = createEditor(text, selectLines(text, 0, 6));
	expectRejected(
		host,
		UNPOPUP,
		editor,
		t('The selection spans multiple popup blocks; only one can be restored at a time.'),
	);
});

test('外层标签不在支持列表里时拒绝', () => {
	const host = createHost({ supportedTags: 'p', popupTag: 'p' });
	registerCommands(host);
	const text = '<div>\na\n</div>';
	const editor = createEditor(text, selectLines(text, 0, 2));
	expectRejected(
		host,
		UNPOPUP,
		editor,
		t('No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.'),
	);
});

// —— 往返 ——

test('Popup 之后紧接着 Unpopup 回到原文', () => {
	const host = createHost();
	registerCommands(host);
	const original = 'hello **world**\n\nsecond';
	const editor = createEditor(original);
	runCommand(host, POPUP, editor);
	const wrapped = editor.getValue();
	const restored = createEditor(wrapped);
	runCommand(host, UNPOPUP, restored);
	assert.notEqual(wrapped, original, 'Popup 应该改写了原文');
	assert.equal(restored.getValue(), original, '往返应回到原文');
});
