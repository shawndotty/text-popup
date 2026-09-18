/**
 * `convert.ts` 的行为用例 —— Popup / Unpopup 的纯函数核心。
 *
 * 这里覆盖三块：`markdownToHtml`（正向）、`htmlToMarkdown`（反向）、以及选区守卫与
 * 外层元素定位（`hasTooDeepIndent` / `findOuterPopupElement`）。
 *
 * 有意固定下来的「反直觉但正是设计意图」的约定（改动前先读 `convert.ts` 文件头）：
 * - `<br>` 后面**不**跟源码换行：弹窗的富文本渲染走 MarkdownRenderer，软换行也会渲染成 `<br>`，
 *   跟一个换行会让原文一行变成两行。因此正文必须压在单行里。
 * - `[[笔记]]` / `[t](u)` / `$x$` **不**转换：留原文，弹窗里才能渲染成可点击链接与公式。
 *
 * 刻意没测：无。本文件只 import 纯函数模块，不需要 obsidian 桩。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { findOuterPopupElement, hasTooDeepIndent, htmlToMarkdown, markdownToHtml } =
	await jiti.import('../src/convert.ts');

/** 断言时统一带上输入，失败信息里能直接看到是哪条样例。 */
function eq(actual, expected, input) {
	assert.deepEqual(actual, expected, `输入: ${JSON.stringify(input)}`);
}

/** 从 `<tag>\n正文\n</tag>` 里取正文（反向用例的输入）。 */
function innerOf(html) {
	return html.slice(html.indexOf('\n') + 1, html.lastIndexOf('\n'));
}

// —— 生成格式 ——

test('生成格式为「外层标签独占一行、正文压在单行」', () => {
	eq(markdownToHtml('a **b**', 'div'), '<div>\na <strong>b</strong>\n</div>', 'a **b**');
});

test('外层标签跟随设置传入的标签名', () => {
	eq(markdownToHtml('a', 'p'), '<p>\na\n</p>', 'a');
});

test('每个换行生成一个 br，空行生成相邻两个 br', () => {
	eq(markdownToHtml('a\nb', 'div'), '<div>\na<br>b\n</div>', 'a\\nb');
	eq(markdownToHtml('a\n\nb', 'div'), '<div>\na<br><br>b\n</div>', 'a\\n\\nb');
});

test('选区末尾的空行被丢掉', () => {
	eq(markdownToHtml('a\n', 'div'), '<div>\na\n</div>', 'a\\n');
	eq(markdownToHtml('a\n\n\n', 'div'), '<div>\na\n</div>', 'a\\n\\n\\n');
});

test('CRLF 被归一化为 LF', () => {
	eq(markdownToHtml('a\r\nb', 'div'), '<div>\na<br>b\n</div>', 'a\\r\\nb');
	eq(markdownToHtml('a\rb', 'div'), '<div>\na<br>b\n</div>', 'a\\rb');
});

test('正文压在单行里：除包裹标签自身那两个换行外不含裸换行', () => {
	// 这是 convert.ts 文件头的硬约束：块级原始 HTML 到第一个空行就结束，
	// 正文一旦出现裸换行，块会被截断、后半段掉出弹窗。用 <br> 表达换行正是为此。
	for (const input of ['plain', 'a\nb', 'a\n\nb', 'a\nb\n\nc', '**粗** 与 `code`']) {
		const body = innerOf(markdownToHtml(input, 'div'));
		assert.ok(!body.includes('\n'), `正文不应含裸换行，输入: ${JSON.stringify(input)}`);
	}
});

// —— 强调标记 ——

test('六种强调标记各自映射到 strong / em / mark / del', () => {
	eq(
		markdownToHtml('**粗** __粗2__ *斜* _斜2_ ==高== ~~删~~', 'div'),
		'<div>\n<strong>粗</strong> <strong>粗2</strong> <em>斜</em> <em>斜2</em> <mark>高</mark> <del>删</del>\n</div>',
		'全部强调标记',
	);
});

test('词内下划线不被当成斜体（snake_case 保持原样）', () => {
	eq(markdownToHtml('snake_case_name', 'div'), '<div>\nsnake_case_name\n</div>', 'snake_case_name');
});

test('强调标记可以嵌套', () => {
	eq(
		markdownToHtml('**粗 *斜* 体**', 'div'),
		'<div>\n<strong>粗 <em>斜</em> 体</strong>\n</div>',
		'**粗 *斜* 体**',
	);
});

// —— 代码与转义 ——

test('行内代码转 code 标签，内容里的尖括号被转义', () => {
	eq(markdownToHtml('`x < y & z`', 'div'), '<div>\n<code>x &lt; y & z</code>\n</div>', '`x < y & z`');
});

test('裸尖括号被转义，已有实体不会被再转一层', () => {
	eq(markdownToHtml('a < b', 'div'), '<div>\na &lt; b\n</div>', 'a < b');
	eq(markdownToHtml('&amp;lt;', 'div'), '<div>\n&amp;amp;lt;\n</div>', '&amp;lt;');
});

test('普通 & 不动，完整标签原样透传', () => {
	eq(markdownToHtml('AT&T', 'div'), '<div>\nAT&T\n</div>', 'AT&T');
	eq(
		markdownToHtml('a <span class="x">b</span>', 'div'),
		'<div>\na <span class="x">b</span>\n</div>',
		'<span class="x">',
	);
});

test('没有配对反引号时反引号当普通字符', () => {
	eq(markdownToHtml('a ` b', 'div'), '<div>\na ` b\n</div>', 'a ` b');
});

test('链接、嵌入与行内公式有意保持原文（交给弹窗的 MarkdownRenderer）', () => {
	eq(
		markdownToHtml('[[笔记]] [t](u) ![[img]] $x$', 'div'),
		'<div>\n[[笔记]] [t](u) ![[img]] $x$\n</div>',
		'链接与公式',
	);
});

// —— 反向还原 ——

test('行内标签还原成对应 Markdown 标记', () => {
	eq(htmlToMarkdown('<strong>a</strong>'), '**a**', '<strong>');
	eq(htmlToMarkdown('<em>a</em>'), '*a*', '<em>');
	eq(htmlToMarkdown('<mark>a</mark>'), '==a==', '<mark>');
	eq(htmlToMarkdown('<del>a</del>'), '~~a~~', '<del>');
	eq(htmlToMarkdown('<b>a</b> <i>b</i> <s>c</s>'), '**a** *b* ~~c~~', 'b/i/s 别名');
});

test('行内标签上的属性被丢弃，只保留标记', () => {
	eq(htmlToMarkdown('<strong class="x">a</strong>'), '**a**', '<strong class="x">');
});

test('code 标签内容按字面还原实体', () => {
	eq(htmlToMarkdown('<code>a &lt; b</code>'), '`a < b`', '<code>a &lt; b</code>');
});

test('br 还原为换行，且吃掉紧随的源码换行', () => {
	eq(htmlToMarkdown('a<br>b'), 'a\nb', 'a<br>b');
	eq(htmlToMarkdown('a<br>\nb'), 'a\nb', 'a<br>\\nb');
});

test('未知标签、孤立闭标签、未配对开标签都原样保留', () => {
	eq(htmlToMarkdown('<foo>a</foo>'), '<foo>a</foo>', '<foo>');
	eq(htmlToMarkdown('a</strong>b'), 'a</strong>b', '孤立闭标签');
	eq(htmlToMarkdown('<strong>a'), '<strong>a', '未配对开标签');
});

test('实体还原是单趟的，&amp;lt; 不会被折叠两级', () => {
	eq(htmlToMarkdown('&lt;&gt;&amp;'), '<>&', '三种实体');
	eq(htmlToMarkdown('&amp;lt;'), '&lt;', '&amp;lt;');
});

test('嵌套标签递归还原', () => {
	eq(htmlToMarkdown('<strong>粗 <em>斜</em> 体</strong>'), '**粗 *斜* 体**', '嵌套');
});

test('首尾各一个换行被去掉（标签独占一行的那两个换行）', () => {
	eq(htmlToMarkdown('\na\n'), 'a', '\\na\\n');
});

// —— 往返 ——

test('markdownToHtml → htmlToMarkdown 往返后回到原文', () => {
	const cases = ['plain', 'a **b**', 'a\n\nb', '**粗** 与 `code`', 'a\nb\n\nc', '==高== ~~删~~'];
	for (const input of cases) {
		const html = markdownToHtml(input, 'div');
		assert.equal(htmlToMarkdown(innerOf(html)), input, `往返失败，输入: ${JSON.stringify(input)}`);
	}
});

// —— 缩进守卫 ——

test('首行缩进 0–3 个空格通过，4 个空格或含制表符被拒绝', () => {
	assert.equal(hasTooDeepIndent('abc'), false, '无缩进');
	assert.equal(hasTooDeepIndent('   abc'), false, '3 空格');
	assert.equal(hasTooDeepIndent('    abc'), true, '4 空格');
	assert.equal(hasTooDeepIndent('\tabc'), true, '制表符');
});

test('缩进只看首行（后续行的缩进不影响判定）', () => {
	assert.equal(hasTooDeepIndent('a\n    b'), false, '首行无缩进');
});

// —— 外层元素定位 ——

test('定位到外层元素并给出 <T>…</T> 的区间', () => {
	const element = findOuterPopupElement('<div>\na\n</div>', ['div']);
	assert.deepEqual(element, { tag: 'div', inner: '\na\n', start: 0, end: 14 }, '最简单形态');
});

test('闭标签取区间里最后一个，块外的用户后文留在区间之外', () => {
	const raw = '<div>\na\n</div>\n用户后文';
	const element = findOuterPopupElement(raw, ['div']);
	assert.equal(element?.inner, '\na\n', 'inner 不含后文');
	assert.equal(raw.slice(element?.end ?? 0), '\n用户后文', '后文落在 end 之后');
});

test('内容里嵌套了同标签时，取最后一个闭标签才不会截断', () => {
	const element = findOuterPopupElement('<div>\nouter <div>inner</div>\n</div>', ['div']);
	assert.equal(element?.inner, '\nouter <div>inner</div>\n', '嵌套内容完整保留');
});

test('标签不在支持列表里时返回 null', () => {
	assert.equal(findOuterPopupElement('<span>a</span>', ['div']), null, 'span 不在列表');
});

test('缺闭标签、空元素、缩进过深时都返回 null', () => {
	assert.equal(findOuterPopupElement('<div>\na\n', ['div']), null, '缺闭标签');
	assert.equal(findOuterPopupElement('<div></div>', ['div']), null, '空元素');
	assert.equal(findOuterPopupElement('    <div>\na\n</div>', ['div']), null, '4 空格缩进');
});

test('支持列表里的任意块级标签都认', () => {
	assert.equal(findOuterPopupElement('<p>\na\n</p>', ['div', 'p'])?.tag, 'p', '列表含 p');
});
