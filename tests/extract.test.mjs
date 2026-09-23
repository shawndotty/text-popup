/**
 * `extract.ts` 的正文提取用例 —— 围栏代码块 / Callout / 引用块 / 数学块 / 表格的「去壳」。
 *
 * 这些函数只在「关闭富文本渲染」的纯文本回退路径上使用（打开时弹窗直接回灌区间原文，
 * 交给 MarkdownRenderer 渲染），所以它们的职责很窄：把壳去掉、把首尾空白收掉。
 * 表格是唯一「不去壳」的一类（`|` 网格本身就是内容），它只做去首尾空行 + 空表判空。
 *
 * 刻意没测：`extractText` 与 `extractRichSource`。两者依赖真实布局（`innerText`、`cloneNode`
 * 后的 `innerHTML` 与去缩进），在 Node 里造不出可信的等价物 —— 硬塞假 DOM 会变成「测假 DOM」。
 * 它们的验证手段是真机交互，不是这里的单测。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	extractCalloutBody,
	extractCanvasBody,
	extractFencedBody,
	extractImageBody,
	extractMathBody,
	extractQuoteBody,
	extractTableBody,
	isExcalidrawEmbed,
	resolveCanvasFile,
	resolveExcalidrawImage,
	wikiEmbedTarget,
} = await jiti.import('../src/extract.ts');

// —— extractFencedBody ——

test('围栏代码块去掉开围栏（含 info string）与闭围栏', () => {
	assert.equal(extractFencedBody('```js\ncode\n```'), 'code', '反引号围栏');
	assert.equal(extractFencedBody('~~~python\ncode\n~~~'), 'code', '波浪号围栏');
});

test('围栏代码块去掉正文首尾的空白行', () => {
	assert.equal(extractFencedBody('```\n\n  a  \n\n```'), 'a');
});

test('未闭合的围栏只去掉开围栏', () => {
	assert.equal(extractFencedBody('```js\ncode'), 'code');
});

test('只有一行时不做剥离（行数守卫）', () => {
	assert.equal(extractFencedBody('```'), '', '独占一行的围栏剥完为空');
	assert.equal(extractFencedBody('```js'), '```js', '单行带 info string 不剥');
});

// —— extractCalloutBody ——

test('Callout 去掉每行的 > 前缀，并去掉首行的 [!TYPE] 但保留标题', () => {
	assert.equal(extractCalloutBody('> [!note] Title\n> body'), 'Title\nbody');
});

test('折叠标记 + / - 一并去掉', () => {
	assert.equal(extractCalloutBody('> [!note]+ Title\n> body'), 'Title\nbody');
	assert.equal(extractCalloutBody('> [!tip]- Title\n> body'), 'Title\nbody');
});

test('没有标题的 Callout 只剩正文', () => {
	assert.equal(extractCalloutBody('> [!note]\n> body'), 'body');
});

test('没有 [!TYPE] 的普通引用只去前缀', () => {
	assert.equal(extractCalloutBody('> plain'), 'plain');
});

test('嵌套引用只去一层前缀', () => {
	assert.equal(extractCalloutBody('> [!note]\n> > inner'), '> inner');
});

// —— extractQuoteBody ——
//
// 引用块的纯文本回退：与 `extractCalloutBody` 共用「去一层 `> ` 前缀」那段逻辑，区别只有一条 ——
// **不剥 `[!TYPE]`**：`> [!note] x` 在扫描器里是 Callout（`matchCallout` 先命中），真走到引用块时
// `[!note]` 就是用户想看的原文。

test('引用块去掉每行的 > 前缀并收掉首尾空白', () => {
	assert.equal(extractQuoteBody('> a\n> b'), 'a\nb');
	assert.equal(extractQuoteBody('> a\n> '), 'a', '末尾的裸 `>` 行被 trim 掉');
});

test('嵌套引用只去一层前缀', () => {
	assert.equal(extractQuoteBody('> > inner'), '> inner');
});

test('引用块不剥 Callout 标记（剥它的是 extractCalloutBody）', () => {
	assert.equal(extractQuoteBody('> [!note] x'), '[!note] x');
});

test('前导空格 ≤3 个的 `>` 同样去前缀（4 个空格是缩进代码块）', () => {
	assert.equal(extractQuoteBody('   > a'), 'a');
	assert.equal(extractQuoteBody('    > a'), '> a');
});

// —— extractMathBody ——

test('数学块去掉 $$ 定界符并收掉首尾空白', () => {
	assert.equal(extractMathBody('$$a+b=c$$'), 'a+b=c', '同行');
	assert.equal(extractMathBody('$$\na\n$$'), 'a', '跨行');
});

// —— extractImageBody ——
//
// 只用于「关闭富文本渲染」时的纯文本回退：让人看得出是哪张图就够，所以取 alt / 文件名。
// 两种形态的「第二段」含义不同：wiki 形态的 `|100` 是尺寸（数字），`|图注` 才是 alt；
// 路径形态的 alt 在 `[]` 里、`|` 之后是尺寸。

test('wiki 形态取文件名', () => {
	assert.equal(extractImageBody('![[p.png]]'), 'p.png');
	assert.equal(
		extractImageBody('![[Pasted image 20260918091231.png|100]]'),
		'Pasted image 20260918091231.png',
		'数字段是尺寸，跳过',
	);
	assert.equal(extractImageBody('![[p.png|100x200]]'), 'p.png', 'WxH 也是尺寸');
});

test('wiki 形态的非数字段是 alt', () => {
	assert.equal(extractImageBody('![[p.png|图注]]'), '图注');
});

test('路径形态取 alt', () => {
	assert.equal(extractImageBody('![5.png](https://example.com/5.png)'), '5.png');
	assert.equal(extractImageBody('![图注|120](p.png)'), '图注', '| 之后是尺寸');
	assert.equal(extractImageBody('![图注](p.png "标题")'), '图注', '标题在方括号之外');
});

test('没有 alt 时原样返回（返回空串会让候选被当成空块丢掉）', () => {
	assert.equal(extractImageBody('![](p.png)'), '![](p.png)');
});

// —— isExcalidrawEmbed ——
//
// 只在 `createCandidate` 里用来分流：把 Excalidraw wiki embed 路由到「同名 PNG/SVG 图片回退」。
// 严格只认 `.excalidraw` / `.excalidraw.md`，普通图片与 Canvas 都不算 — 后两者走通用 image 路径。

test('isExcalidrawEmbed 只认 .excalidraw 与 .excalidraw.md', () => {
	assert.equal(isExcalidrawEmbed('![[file.excalidraw]]'), true, '.excalidraw');
	assert.equal(isExcalidrawEmbed('![[file.excalidraw.md]]'), true, '.excalidraw.md');
	assert.equal(
		isExcalidrawEmbed('![[folder/file.excalidraw|100]]'),
		true,
		'带尺寸后缀仍识别',
	);
	assert.equal(isExcalidrawEmbed('![[file.excalidraw#section]]'), true, '带锚点仍识别');
	assert.equal(isExcalidrawEmbed('![[file.png]]'), false, '普通图片不算');
	assert.equal(isExcalidrawEmbed('![[file.canvas]]'), false, 'Canvas 不算');
	assert.equal(isExcalidrawEmbed('![[file.base]]'), false, 'Bases 不算');
	assert.equal(isExcalidrawEmbed('![[note]]'), false, '普通笔记不算');
});

// —— resolveExcalidrawImage ——
//
// 把 `![[xxx.excalidraw]]` 改写为同名 `xxx.excalidraw.svg` / `.png` 的嵌入路径。
// 优先格式先找，找不到再找回退格式，两个都不存在则返回 null（候选丢弃，由调用方告警）。
// 测试用 fake metadataCache，duck typing 返回 `{ path }` —— 与生产里 `getFirstLinkpath: TFile` 同形。

/** 造一个 fake app：按 linkpath → 路径 的预设表返回 TFile-like。 */
function fakeApp(resolver) {
	return {
		metadataCache: {
			getFirstLinkpathDest: (linkpath) => {
				const path = resolver(linkpath);
				return path ? { path } : null;
			},
		},
	};
}

test('resolveExcalidrawImage 默认走 SVG 优先', () => {
	const app = fakeApp((link) => {
		if (link === 'file.excalidraw.svg') return 'folder/file.excalidraw.svg';
		return null;
	});
	assert.equal(
		resolveExcalidrawImage(app, '![[file.excalidraw]]', 'folder/note.md', 'svg'),
		'folder/file.excalidraw.svg',
	);
});

test('resolveExcalidrawImage 找不到 SVG 时回退 PNG', () => {
	const app = fakeApp((link) => {
		if (link === 'file2.excalidraw.png') return 'folder/file2.excalidraw.png';
		return null;
	});
	assert.equal(
		resolveExcalidrawImage(app, '![[file2.excalidraw]]', '', 'svg'),
		'folder/file2.excalidraw.png',
	);
});

test('resolveExcalidrawImage 优先格式设为 png 时先找 PNG 再回退 SVG', () => {
	const app = fakeApp((link) => {
		if (link === 'file.excalidraw.png') return 'folder/file.excalidraw.png';
		if (link === 'file.excalidraw.svg') return 'folder/file.excalidraw.svg';
		return null;
	});
	assert.equal(
		resolveExcalidrawImage(app, '![[file.excalidraw]]', '', 'png'),
		'folder/file.excalidraw.png',
		'优先 PNG',
	);
});

test('resolveExcalidrawImage 两种都不存在时返回 null', () => {
	const app = fakeApp(() => null);
	assert.equal(
		resolveExcalidrawImage(app, '![[missing.excalidraw]]', '', 'svg'),
		null,
	);
});

test('resolveExcalidrawImage 兼容 .excalidraw.md 后缀', () => {
	const app = fakeApp((link) => {
		if (link === 'file.excalidraw.svg') return 'file.excalidraw.svg';
		return null;
	});
	assert.equal(
		resolveExcalidrawImage(app, '![[file.excalidraw.md]]', '', 'svg'),
		'file.excalidraw.svg',
	);
});

test('resolveExcalidrawImage 非 Excalidraw embed 找不到同名图片时也返回 null', () => {
	// 调用方应先用 isExcalidrawEmbed 守卫；这里只验证「找不到候选文件」时不会误返回路径。
	const app = fakeApp(() => null);
	assert.equal(resolveExcalidrawImage(app, '![[file.png]]', '', 'svg'), null);
	assert.equal(resolveExcalidrawImage(app, '![[file.canvas]]', '', 'svg'), null);
});

// —— wikiEmbedTarget / extractCanvasBody / resolveCanvasFile（V119） ——
//
// Canvas 独立成类之后，这三条是「一个 wiki embed 指向哪个文件」的唯一入口：
// 候选集（session.ts）与图标（inject.ts 的 canMagnifyEmbed）两侧都走它 ——
// 两侧各写一份就会漂移，漂移出来的就是「有图标却翻不到」的幽灵。

test('wikiEmbedTarget 取 target 并去掉 |尺寸 与 #子路径', () => {
	assert.equal(wikiEmbedTarget('![[board.canvas]]'), 'board.canvas');
	assert.equal(wikiEmbedTarget('![[subfolder/board.canvas|300]]'), 'subfolder/board.canvas');
	assert.equal(wikiEmbedTarget('![[board.canvas#^abc]]'), 'board.canvas');
	assert.equal(wikiEmbedTarget('![[board.canvas#section|300]]'), 'board.canvas');
	assert.equal(wikiEmbedTarget('不是 wiki embed'), null, '非 wiki 形态返回 null');
	assert.equal(wikiEmbedTarget('![x](board.canvas)'), null, '圆括号形态不算');
});

test('extractCanvasBody 取文件名（关闭富文本渲染时的纯文本回退）', () => {
	assert.equal(extractCanvasBody('![[board.canvas]]'), 'board.canvas');
	assert.equal(extractCanvasBody('![[Canvas-20260923-084927.canvas|400]]'), 'Canvas-20260923-084927.canvas');
	assert.equal(extractCanvasBody('没法解析的写法'), '没法解析的写法', '解析不出来时原样返回，不留空串');
});

test('resolveCanvasFile 解析 wiki embed 到 vault 内的 TFile', () => {
	const app = fakeApp((link) => (link === 'board.canvas' ? 'folder/board.canvas' : null));
	assert.equal(resolveCanvasFile(app, '![[board.canvas]]', 'notes/note.md')?.path, 'folder/board.canvas');
	assert.equal(
		resolveCanvasFile(app, '![[board.canvas|300]]', 'notes/note.md')?.path,
		'folder/board.canvas',
		'`|尺寸` 不影响解析',
	);
});

test('resolveCanvasFile 找不到文件 / 不是 wiki embed 时返回 null（候选会因此被丢弃）', () => {
	const app = fakeApp(() => null);
	assert.equal(resolveCanvasFile(app, '![[missing.canvas]]', ''), null);
	assert.equal(resolveCanvasFile(app, '不是 wiki embed', ''), null);
});

// —— extractTableBody ——
//
// V117：与另外五类相反 —— 表格**不去壳**。它们剥掉的是纯语法噪音（围栏 / `> ` / `$$`），
// 而 `|` 网格本身就是可读内容；要剥就得重排对齐列宽，收益低、易出 bug。
// 唯一例外是「一眼空」的表：只有表头行 + 分隔行、且表头每格都空 → 返回空串让候选被丢掉
// （`createCandidate` 见空即 null），与「只有 `> ` 的空引用块不产候选」同一口径。

test('表格去掉首尾空行，保留 | 网格', () => {
	assert.equal(extractTableBody('| a | b |\n| - | - |'), '| a | b |\n| - | - |', '原样');
	assert.equal(
		extractTableBody('\n| a | b |\n| - | - |\n\n'),
		'| a | b |\n| - | - |',
		'去首尾空行',
	);
	assert.equal(extractTableBody('| a | b |\n| - | - |\n| 1 | 2 |').split('\n').length, 3, '数据行都在');
});

test('纯空表（表头每格都空且无数据行）返回空串，候选会被丢掉', () => {
	assert.equal(extractTableBody('|  |  |\n| - | - |'), '', '两列全空');
	assert.equal(extractTableBody('||\n|-|'), '', '单列全空');
	assert.equal(extractTableBody('\n| |\n| - |\n'), '', '带空行的全空');
});

test('表头有字或有数据行时不算空表（返回原文）', () => {
	assert.equal(extractTableBody('| a |\n| - |'), '| a |\n| - |', '表头有字、无数据行');
	assert.equal(extractTableBody('|  |\n| - |\n| x |'), '|  |\n| - |\n| x |', '表头空但有数据行');
});
