/**
 * `src/filter.ts` —— V123「弹窗搜索过滤」（方案 [[Plan-20260925-072735]] §9.1）。
 *
 * 这一层是**纯函数**：只吃 `TextBlockRegion` 与字符串，不碰 DOM / App，所以能整层钉在单测里
 * （与 `modal.ts` 的 `wheelZoomTarget` / `settleZoomFrame` 同一条理由）。真机只验接线与几何：
 * 键盘（`/` 唤起、`Esc` 抢不抢得过核心关窗、输入法）、布局（过滤框贴底盖住控制条、
 * 开关过滤时正文一行都不动）、以及 `@` 补全弹层贴不贴 `@`。
 *
 * 三条口径来自 [[Discuss-20260925-072827]] 的默认答复，这里各钉一条：
 * - Q5/Q6：`math` / `html` 一并支持、`excalidraw` 单独一路（但不动 `BlockKind`）；
 * - Q7：图片类按**嵌入语法原文**搜（文件名 + 别名 / alt），不查 frontmatter、不读 canvas JSON；
 * - Q8：`名 · 2 / 5 · 已筛选 (12)`，大小写不敏感子串 + 空格分词 AND。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	TYPE_ORDER,
	availableTypes,
	entrySearchText,
	entryTypeOf,
	formatPopupTitle,
	matchEntries,
	parseFilterInput,
	suggestAnchorLeft,
	suggestTypes,
	suggestionContext,
} = await jiti.import('../src/filter.ts');

/** 造一个最小区间：过滤层只认 `kind` 与 `raw`。 */
const region = (kind, raw) => ({ kind, startLine: 0, endLine: 0, raw });

/** 造一条候选元信息。 */
const entry = (type, text) => ({ type, text });

/* ————————————————————————————————————————————————
   parseFilterInput
   ———————————————————————————————————————————————— */

const POOL = ['code', 'callout', 'canvas', 'table', 'quote'];

test('parseFilterInput: 空串是未定态（按全量、不标红）', () => {
	assert.deepEqual(parseFilterInput('', POOL), { field: null, query: '' });
	assert.deepEqual(parseFilterInput('   ', POOL), { field: null, query: '' });
});

test('parseFilterInput: 不以 @ 开头 = 全文搜索，整串都是 query', () => {
	assert.deepEqual(parseFilterInput('abc', POOL), { field: null, query: 'abc' });
	// `@` 出现在中间不算类型令牌（`@` 只在开头才是语法）
	assert.deepEqual(parseFilterInput('a@b', POOL), { field: null, query: 'a@b' });
});

test('parseFilterInput: 空令牌 / 歧义 / 不认识的类型都是未定态', () => {
	assert.deepEqual(parseFilterInput('@', POOL), { field: null, query: '' }, '刚敲下 @ 不该替用户选定');
	assert.deepEqual(
		parseFilterInput('@c', POOL),
		{ field: null, query: '' },
		'code / callout / canvas 都前缀命中 = 歧义',
	);
	assert.deepEqual(
		parseFilterInput('@zzz', POOL),
		{ field: null, query: '' },
		'pool 里没有的类型 = 未定态',
	);
	// 歧义是相对 pool 的：pool 里只有一个候选时 @c 就不再歧义
	assert.deepEqual(parseFilterInput('@c', ['code']), { field: 'code', query: '' });
});

test('parseFilterInput: 唯一缩写与精确匹配', () => {
	assert.deepEqual(parseFilterInput('@tab', POOL), { field: 'table', query: '' }, '唯一缩写');
	assert.deepEqual(parseFilterInput('@table', POOL), { field: 'table', query: '' }, '精确');
});

test('parseFilterInput: @type 之后是 query（空格分词）', () => {
	assert.deepEqual(parseFilterInput('@table x y', POOL), { field: 'table', query: 'x y' });
});

test('parseFilterInput: 不打空格也能用（中文输入法的常态）', () => {
	assert.deepEqual(
		parseFilterInput('@tablexy', POOL),
		{ field: 'table', query: 'xy' },
		'令牌以类型名开头就切分，剩下的当 query',
	);
	assert.deepEqual(parseFilterInput('@code列表', POOL), { field: 'code', query: '列表' });
});

/* ————————————————————————————————————————————————
   matchEntries
   ———————————————————————————————————————————————— */

const ENTRIES = [
	entry('quote', 'Hello World'),
	entry('table', '| a | b |\n| --- | --- |'),
	entry('code', 'print(1)'),
	entry('table', 'ALPHA beta'),
];

test('matchEntries: 大小写不敏感的子串', () => {
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'hello' }), [0]);
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'HeLLo' }), [0]);
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'alpha' }), [3]);
});

test('matchEntries: 空格分词是 AND，与词序无关', () => {
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'world hello' }), [0]);
	// 词序无关：`beta alpha` 同样命中「ALPHA beta」
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'beta alpha' }), [3]);
	assert.deepEqual(
		matchEntries(ENTRIES, { field: null, query: 'hello nope' }),
		[],
		'多词必须全部命中',
	);
});

test('matchEntries: 空 query 只按类型筛', () => {
	assert.deepEqual(matchEntries(ENTRIES, { field: 'table', query: '' }), [1, 3]);
	assert.deepEqual(matchEntries(ENTRIES, { field: 'math', query: '' }), [], '本篇没有的类型');
});

test('matchEntries: 类型与文本是「且」的关系', () => {
	assert.deepEqual(matchEntries(ENTRIES, { field: 'table', query: 'alpha' }), [3]);
	assert.deepEqual(
		matchEntries(ENTRIES, { field: 'quote', query: 'alpha' }),
		[],
		'文本命中但类型不符 = 出局',
	);
});

test('matchEntries: 返回的是全集下标（不是过滤后的子数组），且严格升序', () => {
	// 命中的是第 2、4 条，返回的仍是它们在**全集**里的下标 1 / 3
	assert.deepEqual(matchEntries(ENTRIES, { field: null, query: 'a' }), [1, 3]);
	assert.deepEqual(
		matchEntries([entry('quote', 'x'), entry('table', 'y'), entry('code', 'x')], { field: null, query: 'x' }),
		[0, 2],
	);
	assert.deepEqual(matchEntries([], { field: null, query: 'a' }), []);
});

/* ————————————————————————————————————————————————
   availableTypes / suggestTypes
   ———————————————————————————————————————————————— */

test('availableTypes: 去重，且按 TYPE_ORDER 排序（不按出现顺序）', () => {
	const shuffled = [
		entry('html', ''),
		entry('table', ''),
		entry('image', ''),
		entry('table', ''),
		entry('code', ''),
	];
	assert.deepEqual(availableTypes(shuffled), ['image', 'table', 'code', 'html']);
	assert.deepEqual(availableTypes([]), [], '空候选集');
});

test('TYPE_ORDER 覆盖 BlockKind 的八类 + excalidraw', () => {
	assert.deepEqual([...TYPE_ORDER], [
		'image',
		'table',
		'callout',
		'canvas',
		'excalidraw',
		'quote',
		'code',
		'math',
		'html',
	]);
});

test('suggestTypes: 空令牌给全部，否则按前缀过滤', () => {
	const pool = ['table', 'quote', 'code'];
	assert.deepEqual(suggestTypes('', pool), pool);
	assert.deepEqual(suggestTypes('t', pool), ['table']);
	assert.deepEqual(suggestTypes('co', pool), ['code']);
	assert.deepEqual(suggestTypes('zz', pool), [], '无匹配返回空数组');
});

/* ————————————————————————————————————————————————
   suggestionContext
   ———————————————————————————————————————————————— */

test('suggestionContext: 只在「@ 打头 + 光标在第一个令牌内」时显示', () => {
	assert.deepEqual(suggestionContext('@', 1), { showing: true, token: '' });
	assert.deepEqual(suggestionContext('@ta', 3), { showing: true, token: 'ta' });
	assert.deepEqual(
		suggestionContext('@table x', 7),
		{ showing: false, token: '' },
		'敲了空格进入 query 段 → 收起',
	);
	assert.deepEqual(
		suggestionContext('abc', 3),
		{ showing: false, token: '' },
		'不是 @ 打头（全文搜索）→ 不显示',
	);
});

/* ————————————————————————————————————————————————
   suggestAnchorLeft
   ———————————————————————————————————————————————— */

test('suggestAnchorLeft: 与 `@` 对齐，越界时夹进过滤框', () => {
	assert.equal(suggestAnchorLeft(23, 75, 1481, 16), 23, '正常情形：就是 `@` 左边缘');
	assert.equal(suggestAnchorLeft(1390, 75, 1481, 16), 1390, '正好卡在右边距上，不动');
	assert.equal(
		suggestAnchorLeft(1420, 75, 1481, 16),
		1390,
		'`@` 贴到右端时夹回右边距 —— 这是 V123 反馈二里「屏幕居中」之外的另一半（原来会整块溢出弹窗）',
	);
	assert.equal(suggestAnchorLeft(0, 75, 1481, 16), 0, '`@` 在左端就是 0');
	assert.equal(
		suggestAnchorLeft(23, 2000, 1481, 16),
		0,
		'弹层比过滤框还宽时退回 0（宁可左边贴边，也不出负数把它顶出框外）',
	);
});

/* ————————————————————————————————————————————————
   formatPopupTitle
   ———————————————————————————————————————————————— */

test('formatPopupTitle: 有命中走「当前 / 命中数 · 已筛选 (总数)」', () => {
	assert.equal(formatPopupTitle('笔记', 2, 5, 12, true, '已筛选'), '笔记 · 2 / 5 · 已筛选 (12)');
});

test('formatPopupTitle: 无过滤 / 零命中回到「当前 / 总数」', () => {
	assert.equal(formatPopupTitle('笔记', 7, 12, 12, false, '已筛选'), '笔记 · 7 / 12');
});

test('formatPopupTitle: 只有一条时不加序号（锁住今天的既有行为）', () => {
	assert.equal(formatPopupTitle('笔记', 1, 1, 1, false, '已筛选'), '笔记');
	// 名字为空的兜底（t('Magnified view')）在 modal.ts 的 updateTitle 里做，纯函数只管拼
	assert.equal(formatPopupTitle('', 1, 1, 5, false, ''), ' · 1 / 5');
});

/* ————————————————————————————————————————————————
   entryTypeOf / entrySearchText
   ———————————————————————————————————————————————— */

test('entryTypeOf: excalidraw 单独一路，其余原样返回', () => {
	assert.equal(entryTypeOf(region('image', '![[draw.excalidraw]]')), 'excalidraw');
	assert.equal(entryTypeOf(region('image', '![[draw.excalidraw.md|300]]')), 'excalidraw');
	assert.equal(entryTypeOf(region('image', '![[shot.png]]')), 'image', '普通图片仍是 image');
	assert.equal(entryTypeOf(region('canvas', '![[board.canvas]]')), 'canvas');
});

test('entrySearchText: 代码块带上开围栏的 info string', () => {
	const text = entrySearchText(region('code', '```python\nprint(1)\n```'), 'code');
	assert.ok(text.includes('print(1)'), '正文要能搜到');
	assert.ok(text.includes('python'), '语言名也要能搜到（搜 python 一次捞出所有 Python 块）');
});

test('entrySearchText: 图片类返回嵌入语法原文（文件名 + 别名 / alt 都能搜）', () => {
	const wiki = '![[shot.png|图注]]';
	assert.equal(entrySearchText(region('image', wiki), 'image'), wiki);
	assert.ok(entrySearchText(region('image', wiki), 'image').includes('图注'), 'wiki 别名可搜');
	assert.equal(
		entrySearchText(region('canvas', '![[board.canvas|600]]'), 'canvas'),
		'![[board.canvas|600]]',
	);
	const markdown = '![alt text](https://x/y.png)';
	assert.ok(entrySearchText(region('image', markdown), 'image').includes('alt text'));
});

test('entrySearchText: 其余类型走 readTextBody（与「关富文本时看到的纯文本」同源）', () => {
	assert.equal(entrySearchText(region('math', '$$x^2$$'), 'math'), 'x^2');
	assert.equal(entrySearchText(region('quote', '> 引用正文'), 'quote'), '引用正文');
});

test('entrySearchText: 手写 HTML 取原文（readTextBody 不覆盖 html，不补就会一个字也搜不到）', () => {
	const raw = '<div>\n<p>关键词 apple</p>\n</div>';
	assert.equal(entrySearchText(region('html', raw), 'html'), raw);
	assert.ok(entrySearchText(region('html', raw), 'html').includes('apple'));
});

test('搜得到的一条：@table 里再搜（两段式）能在真数据上跑通', () => {
	const entries = [
		entry('table', '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |'),
		entry('table', '| 名称 | 数量 |\n| --- | --- |\n| 梨 | 5 |'),
		entry('quote', '苹果很好吃'),
	];
	const filter = parseFilterInput('@tab 苹果', availableTypes(entries));
	assert.deepEqual(filter, { field: 'table', query: '苹果' });
	assert.deepEqual(matchEntries(entries, filter), [0]);
});
