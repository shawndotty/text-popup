/**
 * `extract.ts` 的正文提取用例 —— 围栏代码块 / Callout / 引用块 / 数学块的「去壳」。
 *
 * 这些函数只在「关闭富文本渲染」的纯文本回退路径上使用（打开时弹窗直接回灌区间原文，
 * 交给 MarkdownRenderer 渲染），所以它们的职责很窄：把壳去掉、把首尾空白收掉。
 *
 * 刻意没测：`extractText` 与 `extractRichSource`。两者依赖真实布局（`innerText`、`cloneNode`
 * 后的 `innerHTML` 与去缩进），在 Node 里造不出可信的等价物 —— 硬塞假 DOM 会变成「测假 DOM」。
 * 它们的验证手段是真机交互，不是这里的单测。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { extractCalloutBody, extractFencedBody, extractImageBody, extractMathBody, extractQuoteBody } =
	await jiti.import('../src/extract.ts');

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
