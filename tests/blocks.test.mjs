/**
 * `blocks.ts` 的行为用例 —— 七类区块的扫描与标签判定。
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
 * - 引用块只认 `>` 前缀，**不认懒惰续行**（与 `matchCallout` 同一取舍，见下方用例）。
 *
 * 刻意没测：无。本文件只 import 纯函数模块，不需要 obsidian 桩。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { indentColumns, isBlockLevelTag, isCodeIndent, isIndentedCode, isIndentedCodeContinuation, scanTextBlocks } =
	await jiti.import('../src/blocks.ts');
// 表格的互验对象：扫描器的 table 区间必须等于 `matchTable` 的 `[start, end - 1]`
const { matchTable } = await jiti.import('../src/convert/forward-table.ts');

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

test('HTML 块的缩进按容器判（V118）：列表项内的 4 空格照样有 .cm-html-embed', () => {
	// 真机实测：`- 父项` + 4 空格 `<div>` 有 `.cm-html-embed.cm-embed-block`（+ 插件图标）；
	// 另外三种的整段是 `cm-hmd-indented-code`，没有 widget
	assert.deepEqual(outline('- 父项\n    <div>x</div>'), ['html:1-1'], '列表项内 4 空格（相对 2 列）');
	assert.deepEqual(outline('- 父项\n\t<div>x</div>'), ['html:1-1'], 'Tab 缩进');
	assert.deepEqual(outline('段落\n    <div>x</div>'), ['html:1-1'], '段落延续 + 4 空格');
	assert.deepEqual(outline('\n    <div>x</div>'), [], '空行后 + 4 空格 = 缩进代码块');
	assert.deepEqual(outline('    x\n    <div>x</div>'), [], '紧接缩进代码行');
	assert.deepEqual(outline('- 父项\n\n      <div>x</div>'), [], '列表项内空行 + 6 空格（相对 4）');
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

test('围栏的缩进按容器判（V118）：列表项内的 4 空格是正常嵌套，顶格 4 空格才是代码块', () => {
	// 真机实测：列表项内 4 空格缩进的 ```js 有 `.code-block-flair`（+ 本插件图标）、
	// mermaid 那格还建出 `.cm-preview-code-block` widget；另外三种没有 chip、也没有 widget
	assert.deepEqual(
		outline('- 父项\n    ```js\n    const a = 1;\n    ```'),
		['code:1-3'],
		'列表项内 4 空格（相对 2 列）',
	);
	assert.deepEqual(
		outline('- 父项\n    ```mermaid\n    graph TD; a-->b;\n    ```'),
		['code:1-3'],
		'mermaid 同样成条',
	);
	assert.deepEqual(
		outline('- 父项\n\t```js\n\tconst a = 1;\n\t```'),
		['code:1-3'],
		'Tab 缩进',
	);
	assert.deepEqual(
		outline('段落\n    ```js\n    const a = 1;\n    ```'),
		[],
		'段落延续 + 4 空格：围栏可以打断段落，这里确实是缩进代码块',
	);
	assert.deepEqual(outline('- 父项\n\n      ```js\n      const a = 1;\n      ```'), [], '列表项内 6 空格（相对 4）');
	assert.deepEqual(outline('```js\na\n    ```\nb\n```'), ['code:0-4'], '闭围栏也按容器判：4 空格那行不闭合顶格围栏');
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

test('$$ 的缩进几乎不影响成条（V118）：能打断段落、也能在空行后另起块', () => {
	// 真机实测：下面每一格都建出了 `math-block.cm-embed-block`（带 `.embed-actions` + 插件图标）
	assert.deepEqual(outline('\n    $$\n    m=1\n    $$'), ['math:1-3'], '顶格容器 4 空格');
	assert.deepEqual(outline('\n      $$ m=2 $$'), ['math:1-1'], '顶格容器 6 空格（单行）');
	assert.deepEqual(outline('- 父项\n    $$\n    m=3\n    $$'), ['math:1-3'], '列表项内 4 空格');
	assert.deepEqual(outline('- 父项\n\n      $$\n      m=4\n      $$'), ['math:2-4'], '列表项内空行 + 6 空格');
	assert.deepEqual(outline('- 父项\n          $$ m=5 $$'), ['math:1-1'], '列表项内 10 空格 (单行)');
	assert.deepEqual(outline('- 父项\n\t$$\n\tm=6\n\t$$'), ['math:1-3'], 'Tab 缩进');
	assert.deepEqual(outline('段落\n      $$ m=7 $$'), ['math:1-1'], '段落延续 + 6 空格');
});

test('$$ 唯一被吞掉的情况：上一行本身就是缩进行（已在跑的缩进代码块）', () => {
	// 真机实测：这两行整段是 `cm-hmd-indented-code`，没有 `.math-block`
	assert.deepEqual(outline('    x\n    $$ m=1 $$'), [], '紧接缩进代码行');
	assert.deepEqual(outline('- 父项\n    x\n    $$ m=2 $$'), ['math:2-2'], '列表项内的「相对 2 列」不是代码块');
	// 空行**不**终结：`    x` + 空行 + `    $$` 实测是 math，不是代码块（与图片那侧相反）
	assert.deepEqual(outline('    x\n\n    $$ m=3 $$'), ['math:2-2'], '空行之后另起块');
});

// —— Callout ——

test('Callout 到第一个非引用行为止，折叠标记不影响识别', () => {
	assert.deepEqual(outline('> [!note]+ Title\n> body\n\nnext'), ['callout:0-1']);
	assert.deepEqual(outline('> [!tip]- Title\n> body'), ['callout:0-1']);
});

test('没有 [!TYPE] 的普通引用是 quote 区间（不再是「什么都不算」）', () => {
	assert.deepEqual(outline('> 普通引用\n> 第二行'), ['quote:0-1']);
	assert.ok(
		scanTextBlocks('> 普通引用\n> 第二行').every((region) => region.kind !== 'callout'),
		'没有 [!TYPE] 就不是 Callout（V114 起它是第 6 类 quote）',
	);
});

// —— 图片（第 5 类）——
//
// 正例的写法都在真机探针里量过：独立行 / 列表行都会生成带 `.embed-actions` 的
// `.image-embed`（因此有原生放大图标、也必须有我们的一条候选）。反例都是**实测没有图标**的
// 写法，放进候选就会变成「能翻到、但永远没有图标」的幽灵条目。
// 注意：行首是 `>` 的图片**不在这里** —— V114 起它由外层引用块整行覆盖（见「引用块」一节）。

test('五种图片写法各产出一条单行区间，raw 是命中的语法片段', () => {
	const cases = [
		'![alt](p.png)',
		'![[p.png]]',
		'![[p.png|100]]',
		'![alt|120](p.png)',
		'- ![alt](p.png)',
	];
	for (const line of cases) {
		const regions = scanTextBlocks(line);
		assert.deepEqual(outline(line), ['image:0-0'], `区间：${line}`);
		// 列表行的 `- ` 前缀不能进 raw：整行喂给 MarkdownRenderer 会多一层壳
		assert.equal(regions[0]?.raw, line.replace(/^ *[-*>] ?/, ''), `raw：${line}`);
	}
});

test('行首是 `>` 的图片由引用块覆盖，不再单独成条（V114 行为变更）', () => {
	assert.deepEqual(outline('> ![alt](p.png)'), ['quote:0-0'], '一个视觉块只出一条候选');
	assert.equal(
		scanTextBlocks('> ![alt](p.png)')[0]?.raw,
		'> ![alt](p.png)',
		'raw 保留 `> ` 前缀，弹窗里仍能看到这张图',
	);
	assert.deepEqual(outline('- ![alt](p.png)'), ['image:0-0'], '列表行不受影响');
});

test('图片的 target 解析：外链 / 角括号 / 标题 / #? 参数', () => {
	assert.deepEqual(outline('![x](https://example.com/a.png)'), ['image:0-0'], '外链');
	assert.deepEqual(outline('![x](p.png "标题")'), ['image:0-0'], '标题在空白之后');
	assert.deepEqual(outline('![x](p.png#anchor)'), ['image:0-0'], '# 参数不影响');
	assert.deepEqual(outline('![x](https://example.com/page)'), ['image:0-0'], '外链不看扩展名');
	assert.deepEqual(outline('![x](https://youtube.com/watch?v=1)'), ['image:0-0'], '外链带 ? 参数');
});

test('正文里夹一张图仍算候选（真机实测它照样有 .embed-actions）', () => {
	assert.deepEqual(outline('文字 ![x](p.png) 文字'), ['image:0-0']);
});

test('角括号 target 不被行内 HTML 守卫误伤（真机实测核心照建 div.image-embed）', () => {
	assert.deepEqual(outline('![x](<my image.png>)'), ['image:0-0']);
});

test('非图片的嵌入不算图片区间（扩展名不在图片表里）', () => {
	assert.deepEqual(outline('![[某笔记]]'), [], '无扩展名');
	assert.deepEqual(outline('![[x.pdf]]'), [], 'pdf');
	assert.deepEqual(outline('![[x.mp4]]'), [], '视频');
	assert.deepEqual(outline('![x](某笔记)'), [], '路径形态无扩展名');
});

test('实测没有 .image-embed 的四种写法不产图片区间', () => {
	assert.deepEqual(outline('    ![x](p.png)'), [], '顶格 4 空格（前面没有段落）= 缩进代码块');
	assert.deepEqual(outline('| ![x](p.png) | y |'), [], '表格单元格');
	assert.deepEqual(outline('前 <span>![x](p.png)</span> 后'), [], '行内 HTML widget');
	assert.deepEqual(
		outline('- ![x](p.png)\n  - ![y](q.png)\n    - ![z](r.png)'),
		['image:0-0', 'image:1-1', 'image:2-2'],
		'列表行仍算（2 空格与 **4 空格** 两级嵌套，V118 补：4 空格那级原来被误判成代码块）',
	);
});

// —— 图片 · 相对容器的缩进（V118 的行为变更）——
//
// 起因：`碎片笔记-20260921-204234` 里三处图片，只有 Tab 缩进那处点得开。根因是守卫写成
// `/^ {4,}/`（数行首空格），而缩进代码块的真实判据是**相对容器**的。
//
// 下面这张 9 写法矩阵是**真机量出来的事实**（探针笔记整篇滚进视口后读 `.image-embed`），
// 判据就是照它定的；每一行的注释写的是核心的真实行为，不是推导：
//
//   | # | 写法 | 缩进(列) | 容器内容列 | 核心建 .image-embed |
//   | t1 | 段落行 + 4 空格图 | 4 | 0 | 有（段落延续，不是代码块）|
//   | t2 | `- 父项` + 4 空格 `- ![t2]` | 4 | 2 | 有（← 本次 bug 那一格）|
//   | t3 | `- 父项` + 4 空格 `![t3]`（无标记）| 4 | 2 | 有 |
//   | t4 | `1. 有序父项` + 4 空格 `- ![t4]` | 4 | 3 | 有 |
//   | t5 | `- 父项` + 3 空格 `- ![t5]` | 3 | 2 | 有 |
//   | t6 | `- 父项` + Tab `- ![t6]` | 4 | 2 | 有 |
//   | t7 | `- 父项` + 空行 + 6 空格图 | 6 | 2 | **没有**（相对容器满 4 列 = 代码块）|
//   | t8 | `- 父项` + Tab `![t8]` | 4 | 2 | 有 |
//   | t9 | `- 父项` + 2 空格 `- ![t9]` | 2 | 2 | 有 |

test('9 写法矩阵：只有「相对容器满 4 列」的那格不产候选（真机逐格量过）', () => {
	const matrix = [
		['段落行\n    ![t1](t1.png)', ['image:1-1'], 't1 段落延续 + 4 空格'],
		['- 父项\n    - ![t2](t2.png)', ['image:1-1'], 't2 列表 + 4 空格（本次 bug）'],
		['- 父项\n    ![t3](t3.png)', ['image:1-1'], 't3 列表 + 4 空格（无列表标记）'],
		['1. 有序父项\n    - ![t4](t4.png)', ['image:1-1'], 't4 有序列表（容器列 3）'],
		['- 父项\n   - ![t5](t5.png)', ['image:1-1'], 't5 列表 + 3 空格'],
		['- 父项\n\t- ![t6](t6.png)', ['image:1-1'], 't6 列表 + Tab'],
		['- 父项\n\n      ![t7](t7.png)', [], 't7 列表 + 空行 + 6 空格（相对 4 = 代码块）'],
		['- 父项\n\t![t8](t8.png)', ['image:1-1'], 't8 列表 + Tab（无列表标记）'],
		['- 父项\n  - ![t9](t9.png)', ['image:1-1'], 't9 列表 + 2 空格'],
	];
	for (const [text, expected, label] of matrix) {
		assert.deepEqual(outline(text), expected, label);
	}
});

test('缩进代码块「续行」也算代码块：上一行是缩进行时不再成条（防反向幽灵）', () => {
	// 真机实测：这三行的整段都是 `cm-hmd-indented-code`，没有 `.image-embed`
	assert.deepEqual(outline('    x\n    ![i](p.png)'), [], '上一篇缩进行之后');
	assert.deepEqual(outline('    x\n\n    ![i](p.png)'), [], '空行不终结缩进代码块');
	// 反过来：列表项内的「相对 2 列」不是代码块，照常成条
	assert.deepEqual(outline('- 父项\n    x\n    ![i](p.png)'), ['image:2-2'], '列表项内两行之后');
});

test('碎片笔记-20260921-204234 的三处形状：Tab 与 4 空格都各成一条候选', () => {
	// 原样复刻那篇笔记的三处（Tab / 4 空格 / 4 空格），修复前只有第 1 条
	const text = [
		'- IOTO Framework Settings插件',
		'\t- ![505](https://x/a.png)',
		'',
		'- IOTO Framework Settings插件',
		'    - ![505](https://x/a.png)',
		'',
		'- IOTO Framework Settings插件',
		'    - ![505](https://x/a.png)',
	].join('\n');
	assert.deepEqual(outline(text), ['image:1-1', 'image:4-4', 'image:7-7']);
});

// —— 缩进判据本身（V118 新增的原语）——

test('indentColumns 按 tab stop 展开（不是数空格）', () => {
	assert.equal(indentColumns(''), 0);
	assert.equal(indentColumns('x'), 0);
	assert.equal(indentColumns('   x'), 3);
	assert.equal(indentColumns('\tx'), 4, '一个 Tab = 4 列');
	assert.equal(indentColumns(' \tx'), 4, '空格 + Tab 补到下一个 tab stop');
	assert.equal(indentColumns('  \tx'), 4);
	assert.equal(indentColumns('    \tx'), 8);
	assert.equal(indentColumns('\t\tx'), 8);
});

test('isCodeIndent：同一段缩进在顶格是代码块、在列表项里不是', () => {
	assert.equal(isCodeIndent(['    x'], 0), true, '顶格 4 空格');
	assert.equal(isCodeIndent(['- a', '    x'], 1), false, '列表项（容器列 2）里的 4 空格');
	assert.equal(isCodeIndent(['1. a', '    x'], 1), false, '有序列表（容器列 3）里的 4 空格');
	assert.equal(isCodeIndent(['- a', '  - b', '      x'], 2), false, '嵌套两层（容器列 4）里的 6 空格');
	assert.equal(isCodeIndent(['- a', '      - b', '      x'], 2), true, '更深的兄弟项不是容器，继续上找');
	assert.equal(isCodeIndent(['段落', '    x'], 1), true, '顶格段落后（容器列 0）的 4 空格');
});

test('isIndentedCode / isIndentedCodeContinuation 的分支（空行那条只豁免前者）', () => {
	assert.equal(isIndentedCode(['    x'], 0), true, '文首第一行');
	assert.equal(isIndentedCode(['段落', '    x'], 1), false, '上一行非空且非缩进 = 段落延续');
	assert.equal(isIndentedCode(['', '    x'], 1), true, '空行之后');
	assert.equal(isIndentedCode(['    a', '    b'], 1), true, '续在一个已开的代码块里');
	assert.equal(isIndentedCode(['- a', '', '      x'], 2), true, '列表项内空行之后（相对 4 列）');

	assert.equal(isIndentedCodeContinuation(['    a', '    b'], 1), true, '续行');
	assert.equal(isIndentedCodeContinuation(['', '    x'], 1), false, '空行之后起块，不是续行');
	assert.equal(isIndentedCodeContinuation(['段落', '    x'], 1), false, '段落延续');
	assert.equal(isIndentedCodeContinuation(['    x'], 0), false, '文首没有可续的上一行');
});

// —— 图片 · 行内代码里的图片（V114 新增的第四条行级排除）——
//
// 判据同样是「实测没有 `.image-embed`」：`` `![[x]]` `` 在 LP 里只是 `span.cm-inline-code`。
// 反引号本身在 LP 的 DOM 里被隐藏，文本扫描器看不到，因此由 `inlineCodeRanges` 按四条实测
// 规则算出代码区间（等长闭合 / 未闭合吃到行尾 / 奇偶反斜杠决定转义 / 不跨行）。
// 下面是「该排除的」与「不该被误伤的」两半 —— 后者是防止从一个幽灵变成另一个幽灵。

test('行内代码里的图片语法一律不产候选（夹在文字 / 列表 / 标题里也一样）', () => {
	assert.deepEqual(outline('`![x](p.png)`'), [], '行内 Markdown 图片');
	assert.deepEqual(outline('`![[p.png]]`'), [], '行内 wiki 嵌入');
	assert.deepEqual(outline('``![x](p.png)``'), [], '双反引号包裹');
	assert.deepEqual(outline('前 `![x](p.png)` 后'), [], '夹在正文里');
	assert.deepEqual(outline('- `![x](p.png)`'), [], '列表行');
	assert.deepEqual(outline('## `![x](p.png)`'), [], '标题行');
	assert.deepEqual(outline('` ![x](p.png)'), [], '反引号后紧跟空格');
});

test('未闭合的反引号按 LP 处理：整段到行尾都算代码', () => {
	// 实测 `span.cm-inline-code` 覆盖到行尾、没有 .image-embed（阅读视图相反，见 README 已知限制）
	assert.deepEqual(outline('`![x](p.png)'), [], '未闭合');
	assert.deepEqual(outline('`abc ![x](p.png) def'), [], '未闭合 + 后文');
	assert.deepEqual(outline('`a`` ![x](p.png)'), [], '1 个开、2 个闭：长度不等，未闭合');
	assert.deepEqual(outline('``a` ![x](p.png)'), [], '2 个开、1 个闭：长度不等，未闭合');
});

test('反引号前的反斜杠按奇偶判转义（仅奇数个算被转义）', () => {
	// 奇数个：反引号被转义、不是代码段起点，图片照常成条
	assert.deepEqual(outline('\\`![x](p.png)'), ['image:0-0'], '1 个反斜杠');
	// 偶数个：`\\` 先被还原成一个字面反斜杠，反引号仍是真定界符、图片落在代码段里
	assert.deepEqual(outline('\\\\`![x](p.png)`'), [], '2 个反斜杠');
});

test('代码段在图片之前闭合、或根本不在这一行时，图片照常成条', () => {
	assert.deepEqual(outline('`a` ![x](p.png)'), ['image:0-0'], '代码在前、图片在后');
	assert.deepEqual(outline('`a` ![x](p.png) `b`'), ['image:0-0'], '图片夹在两段代码之间');
	// 规则 4：代码段不跨行 —— 上一行的反引号不会把这一行的图吃掉
	assert.deepEqual(outline('`abc\n![x](p.png)'), ['image:1-1'], '跨行不生效');
});

test('同一行「代码里的图 + 后面的真图」只认真图那条（防反向幽灵）', () => {
	const regions = scanTextBlocks('`![[a.png]]` 然后 ![[b.png]]');
	assert.deepEqual(
		regions.map((region) => `${region.kind}:${region.startLine}-${region.endLine}`),
		['image:0-0'],
		'真图仍是一条候选',
	);
	assert.equal(regions[0]?.raw, '![[b.png]]', 'raw 是那张真图，而不是代码里那张');
});

test('一行两张真图的口径不变：仍只取第一张', () => {
	const regions = scanTextBlocks('![x](a.png) ![y](b.png)');
	assert.deepEqual(outline('![x](a.png) ![y](b.png)'), ['image:0-0']);
	assert.equal(regions[0]?.raw, '![x](a.png)');
});

test('Callout / 围栏 / HTML 块体内的图片被外层吞掉，总数不变', () => {
	assert.deepEqual(
		outline('> [!note]\n> ![x](p.png)'),
		outline('> [!note]\n> body'),
		'Callout 内的图片不另算一条',
	);
	assert.deepEqual(outline('```\n![x](p.png)\n```'), ['code:0-2'], '围栏内');
	assert.deepEqual(outline('<div>\n![x](p.png)\n</div>'), ['html:0-2'], 'HTML 块内');
});

test('图片与其它几类混排时不重叠、按文档顺序', () => {
	const regions = scanTextBlocks(
		[
			'![[cover.png]]', // 0 图片
			'',
			'```js', // 2-4 代码块
			'code',
			'```',
			'',
			'> [!note]', // 6-7 Callout（体内的图片被吞掉）
			'> ![inner.png](inner.png)',
			'',
			'$$a+b$$', // 9 数学块
			'',
			'<div>', // 11-13 HTML 块
			'![in-html.png](x.png)',
			'</div>',
		].join('\n'),
	);
	assert.deepEqual(
		regions.map((region) => `${region.kind}:${region.startLine}-${region.endLine}`),
		['image:0-0', 'code:2-4', 'callout:6-7', 'math:9-9', 'html:11-13'],
	);
	for (let index = 1; index < regions.length; index++) {
		assert.ok(
			(regions[index - 1]?.endLine ?? -1) < (regions[index]?.startLine ?? -1),
			`第 ${index} 个区间与前一个重叠`,
		);
	}
});

// —— 引用块（第 6 类）——
//
// V114 新增。它与其他五类的关系有两条是**行为约定**，都钉在下面：
// 1. `> [!TYPE]` 仍是 Callout（`matchCallout` 排在前面），普通引用才是 quote；
// 2. 引用行里的图片被整段引用覆盖（上面的第 5 类一节已点名），所以「一个视觉块 = 一条候选」。

test('连续 `>` 行成一段引用块，raw 是整段原文（保留 `> ` 前缀）', () => {
	assert.deepEqual(outline('> a'), ['quote:0-0'], '单行');
	assert.deepEqual(outline('> a\n> b'), ['quote:0-1'], '多行成一段');
	assert.deepEqual(outline('> a\n> b\n> '), ['quote:0-2'], '末尾的裸 `>` 行收进同一段');
	assert.deepEqual(outline('> a\n> > inner'), ['quote:0-1'], '嵌套引用由外层覆盖，算一条');
	assert.deepEqual(outline('> a\n> - 列表\n> - 第二个'), ['quote:0-2'], '引用里的列表在同一段内');
	assert.equal(
		scanTextBlocks('> a\n> b')[0]?.raw,
		'> a\n> b',
		'raw 保留 `> ` 前缀：喂给 MarkdownRenderer 正好渲染成一个 blockquote',
	);
});

test('`> [!TYPE]` 仍优先算 Callout，不是 quote', () => {
	assert.deepEqual(outline('> [!note]\n> body'), ['callout:0-1']);
});

test('引用块只认 `>` 前缀，不认懒惰续行（与 matchCallout 同一取舍）', () => {
	assert.deepEqual(outline('> a\n懒惰续行'), ['quote:0-0'], '无 `>` 的第二行不并入');
	assert.deepEqual(outline('> a\n# 标题'), ['quote:0-0'], '引用后接标题即结束');
	assert.deepEqual(outline('普通引用\n> 第二行'), ['quote:1-1'], '`>` 之前的行为普通段落');
});

test('引用块不被外层吞掉，也不吞掉外层：围栏里 / HTML 块里的 `>` 行不算引用', () => {
	assert.deepEqual(outline('> ```js\n> code\n> ```'), ['quote:0-2'], '行首 `>` 后接围栏：整段算引用，不另成代码块');
	assert.deepEqual(outline('```\n> a\n```'), ['code:0-2'], '围栏内的 `>` 行不算引用');
	assert.deepEqual(outline('<div>\n> a\n</div>'), ['html:0-2'], 'HTML 块内的 `>` 行不算引用');
});

test('引用块与图片混排时不重叠、按文档顺序', () => {
	const regions = scanTextBlocks('> a\n\n![x](p.png)\n\n> b');
	assert.deepEqual(
		regions.map((region) => `${region.kind}:${region.startLine}-${region.endLine}`),
		['quote:0-0', 'image:2-2', 'quote:4-4'],
	);
	for (let index = 1; index < regions.length; index++) {
		assert.ok(
			(regions[index - 1]?.endLine ?? -1) < (regions[index]?.startLine ?? -1),
			`第 ${index} 个区间与前一个重叠`,
		);
	}
});

// —— 表格（第 7 类）——
//
// V117 新增。判据 = `convert/forward-table.ts` 的 `matchTable` + 一条**实测补丁**：
// **表头行必须顶格**。真机实测（探针笔记整篇都在视口内，逐个写法量 `.cm-table-widget`）：
//   - 表头行带 1 / 2 / 3 个前导空格时，实时预览**不**建 `.cm-table-widget` —— 那几行只是普通
//     `.cm-line`（列表项延续时甚至是 `HyperMD-list-line-nobullet`）；
//   - 同样内容顶格写就有 widget；「`- item` + 空行 + 顶格表」这个对照也有 widget，
//     所以判据是「表头行有没有前导空白」，不是「在不在列表里」。
// `matchTable` 只拒绝 ≥4 空格的缩进（`hasCodeIndent`），所以少了这条补丁就会出现**幽灵候选**：
// `- item` + 空行 + 2 空格缩进的表能翻到、编辑器里却没有图标可点。

test('顶格表格成区间：文档开头 / 空行后 / 标题后无空行 / 单列 / 列表后顶格', () => {
	assert.deepEqual(outline('| a | b |\n| - | - |'), ['table:0-1'], '文档开头');
	assert.deepEqual(outline('x\n\n| a | b |\n| - | - |'), ['table:2-3'], '空行后');
	assert.deepEqual(outline('## T\n| a | b |\n| - | - |'), ['table:1-2'], 'ATX 标题后无空行');
	assert.deepEqual(outline('| a |\n| - |'), ['table:0-1'], '单列表');
	assert.deepEqual(outline('- item\n\n| a | b |\n| - | - |'), ['table:2-3'], '列表 + 空行 + 顶格表');
});

test('表格的 raw 是整段原文（保留 | 网格，末行正确）', () => {
	const region = scanTextBlocks('x\n\n| a | b |\n| - | - |\n| 1 | 2 |')[0];
	assert.equal(region?.kind, 'table');
	assert.equal(region?.startLine, 2);
	assert.equal(region?.endLine, 4, '数据行吃到第一个终止行');
	assert.equal(region?.raw, '| a | b |\n| - | - |\n| 1 | 2 |');
});

test('实测没有 .cm-table-widget 的写法不产 table 区间', () => {
	assert.deepEqual(outline('text\n| a | b |\n| - | - |'), [], '正文行后无空行（不成块）');
	assert.deepEqual(outline('    | a | b |\n    | - | - |'), [], '4 空格缩进 = 缩进代码块');
	assert.deepEqual(outline('| a |\n---'), [], '`| a |` + `---` 是 Setext 标题（单列表要写 `| - |`）');
	assert.deepEqual(outline(' | a | b |\n | - | - |'), [], '1 空格缩进');
	assert.deepEqual(outline('  | a | b |\n  | - | - |'), [], '2 空格缩进');
	assert.deepEqual(outline('   | a | b |\n   | - | - |'), [], '3 空格缩进');
	assert.deepEqual(
		outline('- item\n\n  | a | b |\n  | - | - |'),
		[],
		'列表项延续（空行后 2 空格缩进）：顶层才有 widget',
	);
	// V118 实测：4 空格那格也没有 widget —— 表格只认顶格，与容器无关（所以它不跟图片 / 围栏 /
	// `$$` / HTML 块一起改成「相对容器」判据，保持原有守卫）
	assert.deepEqual(outline('- item\n\n    | a | b |\n    | - | - |'), [], '列表项内 4 空格');
	assert.deepEqual(outline('> | a | b |\n> | - | - |'), ['quote:0-1'], '引用行里由外层引用块覆盖');
	assert.deepEqual(outline('> [!note]\n> | a | b |\n> | - | - |'), ['callout:0-2'], 'Callout 里由外层覆盖');
	assert.deepEqual(outline('<div>\n| a | b |\n| - | - |\n</div>'), ['html:0-3'], '裸 HTML 块里由外层覆盖');
});

test('表格区间与 matchTable 的 [start, end - 1] 逐一相等（防两份判据漂移）', () => {
	// 全顶格样例（补丁只排除前导空白，所以两组判据在这些样例上必须逐条相同）
	const samples = [
		'| a | b |\n| - | - |',
		'x\n\n| a | b |\n| - | - |',
		'## T\n| a | b |\n| - | - |',
		'| a |\n| - |',
		'| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |',
		'- item\n\n| a | b |\n| - | - |',
		'| a | b |\n| - | - |\n\ntext\n\n| c | d |\n| - | - |',
	];
	for (const text of samples) {
		const lines = text.split('\n');
		const expected = [];
		for (let start = 0; start < lines.length; start++) {
			const table = matchTable(lines, start);
			if (table) expected.push(`${start}-${table.end - 1}`);
		}
		const actual = scanTextBlocks(text)
			.filter((region) => region.kind === 'table')
			.map((region) => `${region.startLine}-${region.endLine}`);
		assert.deepEqual(actual, expected, `样例：${JSON.stringify(text)}`);
	}
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
