/**
 * `extract.ts` 的正文提取用例 —— 围栏代码块 / Callout / 数学块的「去壳」。
 *
 * 这三个函数只在「关闭富文本渲染」的纯文本回退路径上使用（打开时弹窗直接回灌区间原文，
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
const { extractCalloutBody, extractFencedBody, extractMathBody } = await jiti.import('../src/extract.ts');

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

// —— extractMathBody ——

test('数学块去掉 $$ 定界符并收掉首尾空白', () => {
	assert.equal(extractMathBody('$$a+b=c$$'), 'a+b=c', '同行');
	assert.equal(extractMathBody('$$\na\n$$'), 'a', '跨行');
});
