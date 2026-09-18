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
const { findOuterPopupElement, hasBlockBody, hasTooDeepIndent, htmlToMarkdown, isSingleLine, markdownToHtml } =
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

// —— 单行判定（命令层据此选单行 / 多行包裹标签） ——

test('去尾空行后只剩一行时判为单行', () => {
	for (const input of ['a', 'a\n', 'a\n\n', 'a\r\n', 'a\r']) {
		assert.equal(isSingleLine(input), true, `应判为单行，输入: ${JSON.stringify(input)}`);
	}
});

test('含内部换行时判为多行', () => {
	for (const input of ['a\nb', 'a\nb\n', 'a\n\nb', 'a  \nb']) {
		assert.equal(isSingleLine(input), false, `应判为多行，输入: ${JSON.stringify(input)}`);
	}
});

test('空串与纯空白判为单行（命令层先拒空选区，这里只钉行为）', () => {
	assert.equal(isSingleLine(''), true, '空串');
	assert.equal(isSingleLine('   '), true, '纯空格');
	assert.equal(isSingleLine('\n'), true, '只有一个换行');
});

test('不变量：单行判定与生成结果里的 br 严格对应', () => {
	// 判定与生成共用 bodyLines()，这条把两者焊死：任何一侧漂移都会在这里变红（K1）。
	const inputs = [
		'a',
		'a\n',
		'a\n\n',
		'a\r\n',
		'a\r',
		'a\nb',
		'a\nb\n',
		'a\n\nb',
		'a  \nb',
		'',
		'   ',
		'\n',
		'a\n\n\n',
		'a\r\nb',
	];
	for (const input of inputs) {
		const hasBr = markdownToHtml(input, 'div').includes('<br>');
		assert.equal(isSingleLine(input), !hasBr, `判定与生成不一致，输入: ${JSON.stringify(input)}`);
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

// —— 块级转换：Markdown 列表 → HTML 列表 ——
//
// 列表是唯一一个「留原文就彻底失效」的块级语法：`- a<br>- b` 在编辑器与弹窗里都不会成列表。
// 因此它被特判成真正的 HTML 列表，markup 照抄核心（`ul.contains-task-list` / `li.task-list-item` /
// `input.task-list-item-checkbox`），项内容仍走同一条 convertInline。
// 判据刻意收紧（标记后必须空白或行尾、分隔线整行排除）：宁可漏判也不误判。

/** 任务项的固定 markup，只把勾选态与内容留成参数。 */
const taskLi = (checked, content) =>
	`<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"${checked ? ' checked' : ''} disabled> ${content}</li>`;

/** 只关心正文（外层标签由命令层决定）。 */
function body(text) {
	return innerOf(markdownToHtml(text, 'div'));
}

test('无序列表转成 ul：两项、三项、单项、空项', () => {
	eq(body('- a\n- b'), '<ul><li>a</li><li>b</li></ul>', '- a\\n- b');
	eq(body('- a\n- b\n- c'), '<ul><li>a</li><li>b</li><li>c</li></ul>', '三项');
	eq(body('- a'), '<ul><li>a</li></ul>', '单项（单行选区）');
	eq(body('-'), '<ul><li></li></ul>', '空项');
});

test('* 与 + 与 - 同属无序，混用标记也算同一个列表', () => {
	eq(body('* a\n* b'), '<ul><li>a</li><li>b</li></ul>', '* 标记');
	eq(body('+ a\n+ b'), '<ul><li>a</li><li>b</li></ul>', '+ 标记');
	eq(body('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>', '混用标记');
});

test('标记后没有空白的不算列表', () => {
	eq(body('-test'), '-test', '-test');
	eq(body('1.test'), '1.test', '1.test');
	eq(body('*斜体*'), '<em>斜体</em>', '*斜体*（落在行内强调上）');
});

test('分隔线按原文保留，不转列表', () => {
	eq(body('- - -'), '- - -', '- - -');
	eq(body('* * *'), '* * *', '* * *');
	eq(body('---'), '---', '---');
});

test('有序列表转成 ol，标记 . 与 ) 都认', () => {
	eq(body('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>', '1. 标记');
	eq(body('1) a\n2) b'), '<ol><li>a</li><li>b</li></ol>', '1) 标记');
});

test('首项编号不是 1 时带 start，中间编号归一', () => {
	eq(body('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>', '3. 开头');
	eq(body('1. a\n5. b'), '<ol><li>a</li><li>b</li></ol>', '中间编号 5 被归一');
});

test('任务列表：未勾 / 已勾（[x] 与 [X]）的类名与属性', () => {
	eq(
		body('- [ ] a\n- [x] b'),
		`<ul class="contains-task-list">${taskLi(false, 'a')}${taskLi(true, 'b')}</ul>`,
		'未勾 + 已勾',
	);
	eq(body('- [X] c'), `<ul class="contains-task-list">${taskLi(true, 'c')}</ul>`, '[X] 等价于 [x]');
});

test('层里只要有一个任务项，整个列表就带 contains-task-list', () => {
	eq(
		body('- a\n- [ ] b'),
		`<ul class="contains-task-list"><li>a</li>${taskLi(false, 'b')}</ul>`,
		'普通项 + 任务项',
	);
});

test('[x] 后没有空白的不算任务项', () => {
	eq(body('- [x]a'), '<ul><li>[x]a</li></ul>', '- [x]a');
});

test('列表与普通行混排：两侧各一个 br，列表压在正文那一行里', () => {
	eq(
		body('text\n- a\n- b\nafter'),
		'text<br><ul><li>a</li><li>b</li></ul><br>after',
		'text\\n- a\\n- b\\nafter',
	);
	eq(body('**粗**\n- a'), '<strong>粗</strong><br><ul><li>a</li></ul>', '行内标记 + 列表');
});

test('空行打断列表，空行的那个 br 照旧保留', () => {
	// 空行本身贡献一个 <br>（与既有 `a\n\nb` → `a<br><br>b` 同一条规则），
	// 于是两个列表之间是两个 <br> —— 只有这样 Unpopup 才能把空行原样还回去。
	eq(body('- a\n\n- b'), '<ul><li>a</li></ul><br><br><ul><li>b</li></ul>', '- a\\n\\n- b');
});

test('同层换 kind 时另起一个同级列表', () => {
	eq(body('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>', '- a\\n1. b');
});

test('列表项里的行内标记走同一条转换', () => {
	eq(body('- **粗** 与 ==高亮=='), '<ul><li><strong>粗</strong> 与 <mark>高亮</mark></li></ul>', '粗体与高亮');
	eq(body('- `x < y`'), '<ul><li><code>x &lt; y</code></li></ul>', '项内行内代码');
	eq(body('- a < b'), '<ul><li>a &lt; b</li></ul>', '项内裸尖括号');
});

test('嵌套列表：两层与三层', () => {
	eq(body('- a\n  - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>', '两层');
	eq(body('- a\n  - b\n    - c'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>', '三层');
});

test('缩进回退时回到上层继续出同级项', () => {
	eq(body('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', '- a\\n  - b\\n- c');
});

test('子层同缩进换 kind 时变成兄弟层', () => {
	eq(
		body('- a\n  - b\n  1. c'),
		'<ul><li>a<ul><li>b</li></ul><ol><li>c</li></ol></li></ul>',
		'子层换 kind',
	);
});

// —— 单行列表选区判据（命令层据此绕开 p 外壳） ——

test('hasBlockBody：正文里会不会出现块级元素', () => {
	for (const input of ['- a', '1. a', '- [ ] a', 'text\n- a', '- a\n- b', '  - a']) {
		assert.equal(hasBlockBody(input), true, `应判为含块级元素，输入: ${JSON.stringify(input)}`);
	}
	for (const input of ['a', 'a\nb', '', '   ', '-test', '*斜体*', '- - -', '1.test', '---']) {
		assert.equal(hasBlockBody(input), false, `不该判为含块级元素，输入: ${JSON.stringify(input)}`);
	}
});

test('不变量：单行且不含块级元素 ⇔ 正文能用 p 装（没有 br、也没有列表 / 标题）', () => {
	const inputs = [
		'a',
		'a\nb',
		'- a',
		'- a\n- b',
		'text\n- a',
		'1. a',
		'plain',
		'a\n\nb',
		'-test',
		'## 标题',
		'## T\nbody',
		'text\n## T',
		'## T\n| a | b |\n| - | - |',
	];
	for (const input of inputs) {
		const generated = body(input);
		const pSafe = isSingleLine(input) && !hasBlockBody(input);
		assert.equal(
			pSafe,
			!generated.includes('<br>') &&
				!generated.includes('<ul') &&
				!generated.includes('<ol') &&
				!generated.includes('<h1') &&
				!generated.includes('<h2') &&
				!generated.includes('<h3') &&
				!generated.includes('<h4') &&
				!generated.includes('<h5') &&
				!generated.includes('<h6'),
			`p 可用性与生成结果不一致，输入: ${JSON.stringify(input)}`,
		);
	}
});

// —— 反向：HTML 列表 → Markdown 列表 ——

test('反向：ul / ol / ol start 还原成 - 与连续编号', () => {
	eq(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>'), '- a\n- b', '<ul>');
	eq(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b', '<ol>');
	eq(htmlToMarkdown('<ol start="3"><li>a</li><li>b</li></ol>'), '3. a\n4. b', '<ol start="3">');
});

test('反向：任务项按 checked 还原，类名与属性顺序都不影响', () => {
	eq(
		htmlToMarkdown(`<ul class="contains-task-list">${taskLi(false, 'a')}${taskLi(true, 'b')}</ul>`),
		'- [ ] a\n- [x] b',
		'本插件生成的 markup',
	);
	eq(htmlToMarkdown('<ul><li><input type="checkbox" checked> a</li></ul>'), '- [x] a', '手写极简 markup');
});

test('反向：嵌套列表补 2 空格缩进（li 按深度配对）', () => {
	eq(htmlToMarkdown('<ul><li>a<ul><li>b</li></ul></li></ul>'), '- a\n  - b', '两层');
	eq(
		htmlToMarkdown('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>'),
		'- a\n  - b\n    - c',
		'三层',
	);
});

test('反向：项里的行内标记照常还原', () => {
	eq(
		htmlToMarkdown('<ul><li><strong>粗</strong> 与 <mark>高</mark></li></ul>'),
		'- **粗** 与 ==高==',
		'项内行内标签',
	);
});

test('反向：畸形列表整段原样保留（不猜、不修复）', () => {
	eq(htmlToMarkdown('<ul>a</ul>'), '<ul>a</ul>', '没有 li');
	eq(htmlToMarkdown('<ul><li>a</li>'), '<ul><li>a</li>', '缺闭标签');
	eq(
		htmlToMarkdown('<ul><li>a<ul><li>b</li></ul>c</li></ul>'),
		'<ul><li>a<ul><li>b</li></ul>c</li></ul>',
		'嵌套列表之后还有正文',
	);
});

test('列表的 markdownToHtml → htmlToMarkdown 往返回到原文', () => {
	const cases = ['- a\n- b', '1. a\n2. b', '- [x] a\n- [ ] b', '- a\n  - b', 'text\n- a\nafter', '- a\n\n- b'];
	for (const input of cases) {
		const html = markdownToHtml(input, 'div');
		assert.equal(htmlToMarkdown(innerOf(html)), input, `往返失败，输入: ${JSON.stringify(input)}`);
	}
});

// —— 块级转换：Markdown 表格 → HTML 表格 ——
//
// 表格与列表同属「留原文就彻底失效」的块级语法：`| a |` 与 `| - |` 被 `<br>` 压成一行后，
// 编辑器不解析块内 Markdown、弹窗也认不出分隔行 → 两边都不成表格。
// 判据逐条对齐核心（markdown-it 的 table 规则），**宁可漏判也不误判**：
// 必须起一个块、表头行必须含竖线、列数取分隔行、数据行遇到终止行即停。

/** 表格的固定 markup，只把表头行与数据行留成参数。 */
const table = (head, ...rows) =>
	`<table><thead><tr>${head}</tr></thead>` +
	(rows.length > 0 ? `<tbody>${rows.map((row) => `<tr>${row}</tr>`).join('')}</tbody>` : '') +
	'</table>';

test('基本形态：表头进 thead、数据行进 tbody', () => {
	eq(
		body('| a | b |\n| - | - |\n| 1 | 2 |'),
		table('<th>a</th><th>b</th>', '<td>1</td><td>2</td>'),
		'两列一行数据',
	);
	eq(
		body('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'),
		table('<th>a</th><th>b</th>', '<td>1</td><td>2</td>', '<td>3</td><td>4</td>'),
		'两行数据',
	);
});

test('只有表头与分隔行时不出 tbody', () => {
	eq(body('| a | b |\n| - | - |'), table('<th>a</th><th>b</th>'), '无数据行');
});

test('首尾竖线可以省，单横线也合法', () => {
	eq(body('a | b\n--- | ---\n1 | 2'), table('<th>a</th><th>b</th>', '<td>1</td><td>2</td>'), '首尾无竖线');
	eq(body('| a | b |\n| - | - |'), table('<th>a</th><th>b</th>'), '单横线');
	eq(body('x | y\n- | -'), table('<th>x</th><th>y</th>'), '- | -');
});

test('单列表格：表头与分隔行都要写竖线', () => {
	eq(body('| a |\n| - |'), table('<th>a</th>'), '| a | + | - |');
	eq(body('| a |\n|-|'), table('<th>a</th>'), '紧凑写法');
});

test('分隔行没有竖线时不是表格：核心把它渲染成 Setext 标题', () => {
	// 阅读视图实测：`## CASE-A` + 空行 + `| a |` + `---` → 一个 `<h2>| a |</h2>`，没有 <table>
	eq(body('| a |\n---'), '| a |<br>---', '| a | + ---');
});

test('对齐按分隔行的冒号落到 align 属性上（表头与数据行都带）', () => {
	eq(
		body('| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |'),
		table(
			'<th align="left">a</th><th align="right">b</th><th align="center">c</th>',
			'<td align="left">1</td><td align="right">2</td><td align="center">3</td>',
		),
		'左 / 右 / 中',
	);
});

test('列数取分隔行：表头与数据行按它截断 / 补空', () => {
	eq(body('| a |\n| - |\n| 1 | 2 | 3 |'), table('<th>a</th>', '<td>1</td>'), '数据行多出的格被截断');
	eq(body('| a | b |\n| - |\n| 1 |'), table('<th>a</th>', '<td>1</td>'), '表头多出的格被截断');
	eq(body('| a | b |\n| - | - |\n| 1 |'), table('<th>a</th><th>b</th>', '<td>1</td><td></td>'), '少掉的格补空');
});

test('单元格内容走同一套行内转换', () => {
	eq(
		body('| **粗** | `x < y` |\n| - | - |\n| ==高== | ~~删~~ |'),
		table('<th><strong>粗</strong></th><th><code>x &lt; y</code></th>', '<td><mark>高</mark></td><td><del>删</del></td>'),
		'格内行内标记',
	);
});

test('单元格里的转义竖线还原成字面竖线', () => {
	eq(body('| a\\|b | c |\n| - | - |'), table('<th>a|b</th><th>c</th>'), 'a\\|b');
});

test('表格必须起一个块：紧跟在正文后面的表头行只是普通文字', () => {
	eq(body('text\n| a | b |\n| - | - |'), 'text<br>| a | b |<br>| - | - |', 'text 紧邻表头');
	eq(body('*em*\n| a | b |\n| - | - |'), '<em>em</em><br>| a | b |<br>| - | - |', '行内标记紧邻表头');
	eq(
		body('text\n\n| a | b |\n| - | - |'),
		`text<br><br>${table('<th>a</th><th>b</th>')}`,
		'空行后才成表格',
	);
});

test('表头行必须含竖线，否则是 Setext 标题', () => {
	eq(body('a\n---'), 'a<br>---', 'a + ---');
	eq(body('a\n| --- |'), 'a<br>| --- |', 'a + | --- |');
});

test('分隔行不合法就不成表格', () => {
	eq(body('| a | b |'), '| a | b |', '只有表头行');
	eq(body('| a | b |\n| a | b |'), '| a | b |<br>| a | b |', '第二行不是分隔行');
	eq(body('| a | b |\n| - | x |'), '| a | b |<br>| - | x |', '分隔行里有非横线字符');
});

test('数据行的终止条件：空行 / 无竖线 / 缩进 ≥4 / 列表行 / 引用行 / ATX 标题', () => {
	eq(
		body('| a | b |\n| - | - |\n\n| c | d |\n| - | - |'),
		`${table('<th>a</th><th>b</th>')}<br><br>${table('<th>c</th><th>d</th>')}`,
		'空行终止，两行各一张表（空行的 br 照旧保留）',
	);
	eq(
		body('| a | b |\n| - | - |\n| 1 | 2 |\nafter'),
		`${table('<th>a</th><th>b</th>', '<td>1</td><td>2</td>')}<br>after`,
		'无竖线的行终止（表格后面不需要空行）',
	);
	eq(body('| a | b |\n| - | - |\n    | 1 | 2 |'), `${table('<th>a</th><th>b</th>')}<br>    | 1 | 2 |`, '缩进 4 空格');
	eq(
		body('| a | b |\n| - | - |\n- item | x'),
		`${table('<th>a</th><th>b</th>')}<br><ul><li>item | x</li></ul>`,
		'列表行终止',
	);
	eq(body('| a | b |\n| - | - |\n> q | q'), `${table('<th>a</th><th>b</th>')}<br>> q | q`, '引用行终止');
	// ATX 标题同样终止表格；那一行自己按标题转（`# h | h` 是标题，见分流顺序那条）
	eq(
		body('| a | b |\n| - | - |\n# h | h'),
		`${table('<th>a</th><th>b</th>')}<br><h1>h | h</h1>`,
		'ATX 标题终止',
	);
});

test('分隔行出现在数据行位置时只是普通数据行', () => {
	eq(
		body('| a | b |\n| - | - |\n| --- | --- |'),
		table('<th>a</th><th>b</th>', '<td>---</td><td>---</td>'),
		'没有「第二个分隔行终止表格」这回事',
	);
});

test('分流顺序：表格先于列表', () => {
	// 核心的 block 规则里 table 排在 list 之前，`- a | b` + `--- | ---` 是表格而不是列表
	eq(body('- a | b\n--- | ---'), table('<th>- a</th><th>b</th>'), '- a | b + --- | ---');
});

test('正文压在单行里：表格不引入裸换行', () => {
	const html = markdownToHtml('text\n| a | b |\n| - | - |\n| 1 | 2 |\nafter', 'div');
	assert.ok(!innerOf(html).includes('\n'), '正文不应含裸换行');
});

test('表格走多行标签：isSingleLine 为假，hasBlockBody 不受影响', () => {
	const input = '| a | b |\n| - | - |';
	assert.equal(isSingleLine(input), false, '表格天然 ≥2 行');
	assert.equal(hasBlockBody(input), false, '表格不需要 hasBlockBody（p 装得下 > 表格，见 H6）');
});

// —— 反向：HTML 表格 → Markdown 表格 ——

test('反向：本插件生成的 markup 原样还原', () => {
	eq(
		htmlToMarkdown(table('<th>a</th><th>b</th>', '<td>1</td><td>2</td>')),
		'| a | b |\n| --- | --- |\n| 1 | 2 |',
		'thead + tbody',
	);
});

test('反向：第一行一律当表头，没有 thead 也认', () => {
	eq(htmlToMarkdown('<table><tr><th>a</th></tr><tr><td>1</td></tr></table>'), '| a |\n| --- |\n| 1 |', '无 thead');
	eq(htmlToMarkdown('<table><tr><td>a</td></tr></table>'), '| a |\n| --- |', '第一行是 td');
	eq(
		htmlToMarkdown('<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'),
		'| a |\n| --- |\n| 1 |',
		'thead + tbody',
	);
});

test('反向：对齐从表头行逐列读 align', () => {
	eq(
		htmlToMarkdown(
			'<table><tr><th align="left">a</th><th align="right">b</th><th align="center">c</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
		),
		'| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |',
		'左 / 右 / 中',
	);
	eq(
		htmlToMarkdown('<table><tr><th>a</th></tr><tr><td align="right">1</td></tr></table>'),
		'| a |\n| --- |\n| 1 |',
		'属性顺序与引号都容忍；数据行的 align 不参与（对齐只看表头行）',
	);
	eq(
		htmlToMarkdown('<table><tr><th align="justify">a</th></tr></table>'),
		'| a |\n| --- |',
		'表达不了的对齐退回不指定',
	);
});

test('反向：单元格里的字面竖线补上反斜杠', () => {
	eq(htmlToMarkdown('<table><tr><td>a|b</td></tr></table>'), '| a\\|b |\n| --- |', 'a|b');
});

test('反向：表格前面补够空行（表格必须起一个块）', () => {
	eq(
		htmlToMarkdown('text<br><table><tr><th>a</th></tr></table>'),
		'text\n\n| a |\n| --- |',
		'同一行还有内容 → 补一个空行',
	);
	eq(
		htmlToMarkdown('text<br><br><table><tr><th>a</th></tr></table>'),
		'text\n\n| a |\n| --- |',
		'已有空行 → 不再补',
	);
	eq(htmlToMarkdown('<table><tr><th>a</th></tr></table>'), '| a |\n| --- |', '块首 → 不补');
	eq(
		htmlToMarkdown('<table><tr><th>a</th></tr></table><table><tr><th>b</th></tr></table>'),
		'| a |\n| --- |\n\n| b |\n| --- |',
		'两张相邻的表之间补空行',
	);
});

test('反向：畸形表格整段原样保留（不猜、不修复）', () => {
	eq(htmlToMarkdown('<table></table>'), '<table></table>', '没有 tr');
	eq(htmlToMarkdown('<table><tr><th>a</th></tr>'), '<table><tr><th>a</th></tr>', '缺 </table>');
	eq(htmlToMarkdown('<table><tr><td>a</tr></table>'), '<table><tr><td>a</tr></table>', '单元格缺闭标签');
	eq(
		htmlToMarkdown('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table>'),
		'<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table>',
		'格数与表头行不一致（Markdown 表格必须矩形）',
	);
	eq(
		htmlToMarkdown('<table><tr><th colspan="2">a</th></tr><tr><td>1</td><td>2</td></tr></table>'),
		'<table><tr><th colspan="2">a</th></tr><tr><td>1</td><td>2</td></tr></table>',
		'合并单元格表达不了',
	);
	eq(
		htmlToMarkdown('<table><tr><th style="text-align:left">a</th></tr></table>'),
		'<table><tr><th style="text-align:left">a</th></tr></table>',
		'style 不猜',
	);
	eq(
		htmlToMarkdown('<table><tr><th>a</th></tr><tr><td><br></td></tr></table>'),
		'<table><tr><th>a</th></tr><tr><td><br></td></tr></table>',
		'单元格里含换行',
	);
	eq(
		htmlToMarkdown('<table><div>x</div></table>'),
		'<table><div>x</div></table>',
		'表格里夹着别的元素',
	);
	eq(
		htmlToMarkdown('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>'),
		'<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>',
		'嵌套表格',
	);
});

test('反向：colspan="1" 与不写等价，照常还原', () => {
	eq(htmlToMarkdown('<table><tr><th colspan="1">a</th></tr></table>'), '| a |\n| --- |', 'colspan="1"');
});

test('反向：表格里的行内标签照常还原', () => {
	eq(
		htmlToMarkdown('<table><tr><th><strong>粗</strong></th></tr><tr><td><mark>高</mark></td></tr></table>'),
		'| **粗** |\n| --- |\n| ==高== |',
		'格内行内标签',
	);
});

test('表格的 markdownToHtml → htmlToMarkdown 往返（按既定归一化）', () => {
	const cases = [
		['| a | b |\n| - | - |\n| 1 | 2 |', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
		['a | b\n--- | ---\n1 | 2', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
		['| a | b |\n| :--- | ---: |\n| 1 | 2 |', '| a | b |\n| :--- | ---: |\n| 1 | 2 |'],
		['| a\\|b | c |\n| - | - |', '| a\\|b | c |\n| --- | --- |'],
		[
			'text\n\n| a | b |\n| - | - |\n| 1 | 2 |\nafter',
			'text\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\nafter',
		],
	];
	for (const [input, expected] of cases) {
		assert.equal(htmlToMarkdown(innerOf(markdownToHtml(input, 'div'))), expected, `往返失败，输入: ${JSON.stringify(input)}`);
	}
});

test('不变量：表格过一次转换后往返稳定（再转一遍不再变）', () => {
	const cases = [
		'| a | b |\n| - | - |\n| 1 | 2 |',
		'a | b\n--- | ---\n1 | 2',
		'text\n\n| a | b |\n| - | - |',
		'| a | b |\n| - | - |\n| 1 | 2 |\nafter',
		'| a |\n| - |\n| 1 | 2 | 3 |',
	];
	for (const input of cases) {
		const once = htmlToMarkdown(innerOf(markdownToHtml(input, 'div')));
		const twice = htmlToMarkdown(innerOf(markdownToHtml(once, 'div')));
		assert.equal(twice, once, `往返不稳定，输入: ${JSON.stringify(input)}`);
	}
});

// —— 块级转换：Markdown ATX 标题 → HTML 标题 ——
//
// 标题的失效方式是**把同一行的后续内容吃进标题**：`## T<br>正文` 里的 `##` 范围到本行结束，
// `<br>` 只是行内元素、不结束标题 —— 弹窗里于是只剩一个 h2，后文全变成标题文字。
// 判据逐条对齐核心的 ATX 规则（缩进 0–3、`#` 后必须空白或行尾、尾部闭合串、转义），
// **宁可漏判也不误判**；Setext 标题（`S\n===`）本次不做，见 README 的已知限制。

test('判据矩阵：1–6 个 # 是标题，7 个 # 与 #nospace 不是', () => {
	eq(body('# H'), '<h1>H</h1>', '# H');
	eq(body('### H'), '<h3>H</h3>', '### H');
	eq(body('###### H'), '<h6>H</h6>', '###### H');
	eq(body('####### H'), '####### H', '7 个 # 是普通文本');
	eq(body('#nospace'), '#nospace', '#nospace');
});

test('判据矩阵：分隔符是空格或 Tab，缩进 0–3 合法、4 是代码块', () => {
	eq(body('#\tT'), '<h1>T</h1>', '# + Tab');
	eq(body('#     T'), '<h1>T</h1>', '# + 多空格');
	eq(body(' # T'), '<h1>T</h1>', '缩进 1');
	eq(body('   ### T'), '<h3>T</h3>', '缩进 3');
	eq(body('    # T'), '    # T', '缩进 4 = 缩进代码块');
	eq(body('\\# T'), '\\# T', '反斜杠转义的 # 不是标题');
});

test('判据矩阵：尾部闭合串（空白 + 纯 #）去掉，空标题合法', () => {
	eq(body('# T #'), '<h1>T</h1>', '# T #');
	eq(body('# T ###'), '<h1>T</h1>', '# T ###');
	eq(body('# T ####   '), '<h1>T</h1>', '# T #### + 尾空格');
	eq(body('# T #extra'), '<h1>T #extra</h1>', '闭合串必须是纯 #');
	eq(body('# T \\#'), '<h1>T \\#</h1>', '被转义的 # 不算闭合串');
	eq(body('# T#'), '<h1>T#</h1>', '闭合串前面必须有空白');
	eq(body('#'), '<h1></h1>', '裸 #');
	eq(body('###'), '<h3></h3>', '空的三级标题');
});

test('正向 markup：标题转成 hN，后文留在标题外面（用户报的那一条）', () => {
	eq(
		body('## Test Heading\n蜀之鄙有二僧：其一贫，其一富。'),
		'<h2>Test Heading</h2><br>蜀之鄙有二僧：其一贫，其一富。',
		'## Test Heading + 正文',
	);
});

test('标题文字走同一套行内转换', () => {
	eq(body('## **粗** 与 `码`'), '<h2><strong>粗</strong> 与 <code>码</code></h2>', '行内标记');
	eq(body('## 中文标题'), '<h2>中文标题</h2>', '与语言无关');
});

test('分流顺序：标题先于表格', () => {
	// 核心把 `# x | y` + `| - | - |` 判成标题 + 段落（分隔行没有表头行就不能成表）
	eq(body('# x | y\n| - | - |'), '<h1>x | y</h1><br>| - | - |', '# x | y + | - | - |');
	// 既有实测：`- a | b` + `--- | ---` 是表格（表格先于列表），不受标题分流影响
	eq(body('- a | b\n--- | ---'), table('<th>- a</th><th>b</th>'), '- a | b + --- | ---');
});

test('表格可以紧跟在标题后面（上一行是标题也算「起一个块」）', () => {
	eq(
		body('## T\n| a | b |\n| - | - |'),
		`<h2>T</h2><br>${table('<th>a</th><th>b</th>')}`,
		'## T + 表格（无空行）',
	);
});

test('标题紧邻列表：两侧各一个 br，标题压在正文那一行里', () => {
	eq(body('- aa\n## T'), '<ul><li>aa</li></ul><br><h2>T</h2>', '- aa + ## T');
	eq(body('## H\n- a\n- b'), '<h2>H</h2><br><ul><li>a</li><li>b</li></ul>', '## H + 列表');
	eq(body('正文\n## T'), '正文<br><h2>T</h2>', '正文 + ## T（ATX 能打断段落）');
});

test('列表项里的标题与引用行里的标题都不处理（既有边界）', () => {
	eq(body('- # T'), '<ul><li># T</li></ul>', '列表项内的 # 保持字面');
	eq(body('> #### T'), '> #### T', '引用行留给原文（弹窗里 > 会被序列化成 &gt;）');
});

test('正文压在单行里：标题不引入裸换行', () => {
	const html = markdownToHtml('## H\n正文\n- a\n| x | y |\n| - | - |', 'div');
	assert.ok(!innerOf(html).includes('\n'), '正文不应含裸换行');
});

test('hasBlockBody：标题算块级正文（单行选区不能用 p 外壳）', () => {
	for (const input of ['## 标题', '## T\nbody', 'text\n## T', '###', '# T#', '# T \\#']) {
		assert.equal(hasBlockBody(input), true, `应判为含块级元素，输入: ${JSON.stringify(input)}`);
	}
	for (const input of ['####### x', '#nospace', '\\# x', '    # x', 'a', '']) {
		assert.equal(hasBlockBody(input), false, `不该判为含块级元素，输入: ${JSON.stringify(input)}`);
	}
});

// —— 反向：HTML 标题 → Markdown ATX 标题 ——

test('反向：h1–h6 还原成对应数量的 #', () => {
	eq(htmlToMarkdown('<h1>T</h1>'), '# T', '<h1>');
	eq(htmlToMarkdown('<h2>T</h2>'), '## T', '<h2>');
	eq(htmlToMarkdown('<h6>T</h6>'), '###### T', '<h6>');
	eq(htmlToMarkdown('<h3></h3>'), '###', '空标题不留尾空格');
});

test('反向：标题只需要一个换行（不像表格那样补整行空行）', () => {
	eq(htmlToMarkdown('text<br><h2>T</h2>'), 'text\n## T', '前面已有换行时不补');
	eq(htmlToMarkdown('text<h2>T</h2>'), 'text\n## T', '紧贴在文字后面时补一个换行');
	eq(htmlToMarkdown('<h2>T</h2><br>body'), '## T\nbody', '标题后面照常');
});

test('反向：表达不了的标题整段原样保留（不猜、不降级）', () => {
	eq(htmlToMarkdown('<h2 class="x">T</h2>'), '<h2 class="x">T</h2>', '带属性');
	eq(htmlToMarkdown('<h2 style="color:red">T</h2>'), '<h2 style="color:red">T</h2>', '带 style');
	eq(htmlToMarkdown('<h2>a<br>b</h2>'), '<h2>a<br>b</h2>', '内容含换行，Markdown 标题不能跨行');
	eq(htmlToMarkdown('<h2>T'), '<h2>T', '缺闭标签');
	eq(htmlToMarkdown('<h7>T</h7>'), '<h7>T</h7>', 'h7 不在 h1–h6 里');
});

test('反向：标题内容走同一条行内还原，且能与列表 / 表格共处', () => {
	eq(htmlToMarkdown('<h2><strong>粗</strong> 与 <code>x</code></h2>'), '## **粗** 与 `x`', '行内标记');
	eq(htmlToMarkdown('<ul><li>a</li></ul><h2>T</h2>'), '- a\n## T', '列表 + 标题');
	eq(
		htmlToMarkdown(`${table('<th>a</th><th>b</th>')}<h2>T</h2>`),
		'| a | b |\n| --- | --- |\n## T',
		'表格 + 标题（表格补空行、标题只补换行）',
	);
});

test('标题的 markdownToHtml → htmlToMarkdown 往返（按既定归一化）', () => {
	const roundTrip = (input) => htmlToMarkdown(innerOf(markdownToHtml(input, 'div')));

	eq(roundTrip('## Test Heading\n蜀之鄙有二僧：其一贫，其一富。'), '## Test Heading\n蜀之鄙有二僧：其一贫，其一富。', '用户报的那一条');
	eq(roundTrip('## T'), '## T', '单行标题');
	eq(roundTrip('###'), '###', '空标题');
	eq(roundTrip('## T ##'), '## T', '尾部闭合串不保留');
	eq(roundTrip('#\tT'), '# T', '标记后的分隔空白归一成一个空格');
	eq(roundTrip('   ## T'), '## T', '前导缩进被去掉（块内缩进没有语义）');
	eq(roundTrip('## T\n| a | b |\n| - | - |'), '## T\n\n| a | b |\n| --- | --- |', '标题 + 表格');
});

test('不变量：标题过一次转换后往返稳定（再转一遍不再变）', () => {
	const inputs = ['## Test Heading\n正文', '## T', '###', '## T ##', '#\tT', '   ## T', '## T\n| a | b |\n| - | - |'];
	for (const input of inputs) {
		const once = htmlToMarkdown(innerOf(markdownToHtml(input, 'div')));
		const twice = htmlToMarkdown(innerOf(markdownToHtml(once, 'div')));
		assert.equal(twice, once, `往返不稳定，输入: ${JSON.stringify(input)}`);
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
