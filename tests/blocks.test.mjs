/**
 * `blocks.ts` 的行为用例 —— 四类区块的扫描与标签判定。
 *
 * 这是「能翻到几条」的事实来源：扫描结果直接决定 Live Preview 里哪些块会拿到放大图标。
 * 最需要守住的不变量是**区间不重叠、外层优先**：Callout 里嵌的代码块在核心里不生成独立的
 * `.cm-embed-block`，若被当成独立候选就会出现「能翻到、但永远没有图标」的幽灵条目。
 *
 * 已经用探针核对过、与直觉不同但仍属当前实现的点（写在用例里是为了让后来者知道它是**已知**的）：
 * - `script` / `style` / `object` / `embed` / `webview` 不在块级标签表里，因此**不会**产生区间
 *   （`SKIPPED_TAGS` 实际生效的是同在块级表里的 `link` / `meta`）。
 * - ` ```a`b ` 这类信息串里含反引号的写法，本实现仍按围栏起点处理，与文件头注释所述的
 *   markdown-it 规则不一致（markdown-it 要求反引号围栏的信息串不含反引号）。
 *
 * 刻意没测：无。本文件只 import 纯函数模块，不需要 obsidian 桩。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { isBlockLevelTag, scanTextBlocks } = await jiti.import('../src/blocks.ts');

/** 把扫描结果压成 `kind:startLine-endLine`，便于整段断言。 */
function outline(text) {
	return scanTextBlocks(text).map((region) => `${region.kind}:${region.startLine}-${region.endLine}`);
}

// —— 四类识别 ——

test('同一段文本里的四类区块被同时识别，行号区间正确', () => {
	const text = [
		'intro', // 0
		'', // 1
		'```js', // 2
		'code', // 3
		'```', // 4
		'', // 5
		'> [!note] Title', // 6
		'> body', // 7
		'', // 8
		'$$a+b=c$$', // 9
		'', // 10
		'<div>hello</div>', // 11
	].join('\n');
	assert.deepEqual(outline(text), ['code:2-4', 'callout:6-7', 'math:9-9', 'html:11-11']);
});

test('区间的 raw 是该段原文（含围栏 / > 前缀 / $$）', () => {
	const region = scanTextBlocks('<div>\na\n</div>')[0];
	assert.equal(region?.raw, '<div>\na\n</div>', 'html 原文');
	assert.equal(scanTextBlocks('> [!note]\n> x')[0]?.raw, '> [!note]\n> x', 'callout 原文');
	assert.equal(scanTextBlocks('```js\nx\n```')[0]?.raw, '```js\nx\n```', '围栏原文');
});

test('没有任何区块的纯文本返回空数组', () => {
	assert.deepEqual(outline('普通段落\n\n另一段'), []);
});

// —— 块级原始 HTML ——

test('HTML 块到第一个空行为止，文末也结束', () => {
	assert.deepEqual(outline('<div>\na\n\n<div>b</div>'), ['html:0-1', 'html:3-3']);
	assert.deepEqual(outline('<div>\na'), ['html:0-1']);
});

test('div 与 p 同级，各自成区间', () => {
	assert.deepEqual(outline('<div>\na\n</div>\n\n<p>\nb\n</p>'), ['html:0-2', 'html:4-6']);
});

test('link / meta 这类在核心排除表里的标签吃掉区间但不产候选', () => {
	// 0-1 被 <link> 块吃掉（不产候选），后面的 <p> 才是候选 —— 证明「吃掉区间」仍生效
	assert.deepEqual(outline('<link rel="x">\ntrailing\n\n<p>\nb\n</p>'), ['html:3-5']);
});

test('行内表里的标签（span）不是块起始，不产区间', () => {
	assert.deepEqual(outline('<span>a</span>'), []);
});

test('iframe 同时在块表与行内表里，吃掉区间但不产候选', () => {
	assert.deepEqual(outline('<iframe src="x"></iframe>\nrest'), []);
});

test('script 不在块级标签表里，因此整段不产区间', () => {
	assert.deepEqual(outline('<script>\nvar a = 1;\n</script>'), []);
});

// —— 围栏代码块 ——

test('未闭合的围栏吃到文末', () => {
	assert.deepEqual(outline('```\na\nb'), ['code:0-2']);
});

test('波浪号围栏同样识别', () => {
	assert.deepEqual(outline('~~~\na\n~~~'), ['code:0-2']);
});

test('闭围栏长度不足时不算闭合，一直吃到文末', () => {
	assert.deepEqual(outline('````\na\n```'), ['code:0-2']);
});

test('反引号围栏与波浪号围栏互不闭合', () => {
	assert.deepEqual(outline('```\na\n~~~'), ['code:0-2']);
});

test('信息串里含反引号时，当前实现仍按围栏起点处理', () => {
	// 与 blocks.ts 文件头注释所述的 markdown-it 规则不一致：核心不把这种行当围栏。
	// 记在这里是为了让差异可见，而不是把它当成正确行为。
	assert.deepEqual(outline('```a`b\ncode\n```'), ['code:0-2']);
});

test('4 空格缩进的围栏属于缩进代码块，不是候选', () => {
	assert.deepEqual(outline('    ```\na\n    ```'), []);
});

// —— 数学块 ——

test('同一行里出现第二个 $$ 就当场结束', () => {
	assert.deepEqual(outline('$$a+b=c$$'), ['math:0-0']);
});

test('跨行的 $$ 到含 $$ 的那一行结束', () => {
	assert.deepEqual(outline('$$\na\n$$'), ['math:0-2']);
});

test('行内公式 $x$ 不命中数学块', () => {
	assert.deepEqual(outline('$x$'), []);
});

// —— Callout ——

test('Callout 到第一个非引用行为止，折叠标记不影响识别', () => {
	assert.deepEqual(outline('> [!note]+ Title\n> body\n\nnext'), ['callout:0-1']);
	assert.deepEqual(outline('> [!tip]- Title\n> body'), ['callout:0-1']);
});

test('没有 [!TYPE] 的普通引用不算 Callout', () => {
	assert.deepEqual(outline('> 普通引用\n> 第二行'), []);
});

// —— 不重叠（关键不变量）——

test('Callout 里嵌的围栏不单独成区间（外层优先，防幽灵条目）', () => {
	assert.deepEqual(outline('> [!note]\n> 正文\n> ```js\n> code\n> ```\n> 尾'), ['callout:0-5']);
});

test('HTML 块里嵌的围栏不单独成区间', () => {
	assert.deepEqual(outline('<div>\n```js\ncode\n```\n</div>'), ['html:0-4']);
});

test('区间互不重叠且按文档顺序排列', () => {
	const regions = scanTextBlocks('```\na\n```\n\n> [!note]\n> b\n\n$$\nc\n$$');
	for (let index = 1; index < regions.length; index++) {
		assert.ok(
			(regions[index - 1]?.endLine ?? -1) < (regions[index]?.startLine ?? -1),
			`第 ${index} 个区间与前一个重叠`,
		);
	}
});

// —— 标签判定 ——

test('块级标签判定与核心的两张表对齐', () => {
	assert.equal(isBlockLevelTag('div'), true, 'div');
	assert.equal(isBlockLevelTag('p'), true, 'p');
	assert.equal(isBlockLevelTag('section'), true, 'section');
	assert.equal(isBlockLevelTag('span'), false, 'span 是行内');
	assert.equal(isBlockLevelTag('iframe'), false, 'iframe 同时在行内表里');
	assert.equal(isBlockLevelTag('script'), false, 'script 不在块表里');
	assert.equal(isBlockLevelTag('foo'), false, '未知标签');
});

test('标签判定先做 trim + 小写', () => {
	assert.equal(isBlockLevelTag('DIV'), true, 'DIV');
	assert.equal(isBlockLevelTag(' div '), true, '带空格');
});
