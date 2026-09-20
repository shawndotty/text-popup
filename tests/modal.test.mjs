/**
 * `modal.ts` 里几个可单测的纯函数。
 *
 * ① `headingColorVariables` —— V109「弹窗标题色不跟随主题」修复（2026-09-18）。
 *
 * 背景：核心给标题写的是 `color: var(--hN-color)`（app.css 的
 * `h1, .markdown-rendered h1 { color: var(--h1-color) }`），主题（实测 AnuPpuccin）把这六个
 * 变量声明在 `.app-container` 上；而 Obsidian 把弹窗挂在 `body > .modal-container`，与
 * `.app-container` 是**兄弟节点** —— 变量传不进来，弹窗里的标题退回 `:root` 的 `inherit`
 * （空值）→ `color` 回落成继承正文色。
 *
 * 修复是「打开弹窗时把 `.app-container` 上算好的 `--h1-color`…`--h6-color` 搬到弹窗根节点」。
 * 本仓库没有能跑真实样式的 DOM 环境（与 `tests/styles.test.mjs` 同一条理由），所以这里只钉住
 * 那条纯函数（挑哪些变量、空值怎么办）；**DOM 侧的接线（onOpen 里只在「跟随主题」时调用、
 * 以及搬进来后标题色的实际取值）用真机 eval 验收**，见 Report-20260918-213441。
 *
 * ② `clickZoomTarget` / `elementPoint` / `zoomScrollDelta` / `viewportCenter` / `scrollToMove`
 * —— V116「Alt+Click 点哪儿放大哪儿」（2026-09-20，方案 [[Plan-20260920-154434]] §3.3）。
 * 同理：几何公式能钉在单测里，但锚点是否真的不漂移取决于真实布局与滚动夹取，
 * **只能用真机 eval 量**（误差应 < 1px，见 Report-20260920-155615）。
 *
 * ③ `viewportCenter` / `scrollToMove` —— V116 第二次反馈「放大后点击处没到画布中间」
 * （方案 [[Plan-20260920-161511]] §2.2）。这里钉住「推到中心」这条补偿的算式与符号；
 * 「靠近文档边缘时居中会被滚动上限夹掉」属于真实布局的边界，同样只能真机量。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	clickZoomTarget,
	elementPoint,
	headingColorVariables,
	scrollToMove,
	viewportCenter,
	zoomScrollDelta,
} = await jiti.import('../src/modal.ts');

/** 按给定映射造一份最小 computed style（缺席的变量返回空串，与浏览器行为一致）。 */
const styleOf = (map) => ({ getPropertyValue: (name) => map[name] ?? '' });

test('六个层级按 h1→h6 顺序取出，只收有值的', () => {
	assert.deepEqual(
		headingColorVariables(
			styleOf({
				'--h1-color': 'rgb(243, 139, 168)',
				'--h2-color': 'rgb(250, 179, 135)',
				'--h4-color': 'rgb(148, 226, 213)',
			}),
		),
		[
			['--h1-color', 'rgb(243, 139, 168)'],
			['--h2-color', 'rgb(250, 179, 135)'],
			['--h4-color', 'rgb(148, 226, 213)'],
		],
		'顺序与完整名都要对得上',
	);
});

test('空值不收：主题没定义标题色时一个变量都不搬', () => {
	assert.deepEqual(
		headingColorVariables(styleOf({})),
		[],
		'`--hN-color` 取到空串（= 核心 `:root` 的 `inherit`）时不能设成空值，否则标题会失去继承色',
	);
	assert.deepEqual(
		headingColorVariables(styleOf({ '--h3-color': '   ' })),
		[],
		'只有空白的值等同于空值',
	);
});

test('值两侧空白先去掉（computed style 的个别实现会带前导空格）', () => {
	assert.deepEqual(headingColorVariables(styleOf({ '--h6-color': ' rgb(203, 166, 247) ' })), [
		['--h6-color', 'rgb(203, 166, 247)'],
	]);
});

test('六级以外的变量一概不碰', () => {
	const values = headingColorVariables(
		styleOf({
			'--h7-color': 'rgb(1, 2, 3)',
			'--inline-title-color': 'rgb(4, 5, 6)',
			'--text-normal': 'rgb(198, 208, 245)',
		}),
	);
	assert.deepEqual(values, [], '只搬 --h1-color…--h6-color');
});

test('clickZoomTarget：没有「再放大一档」，点一下只是在 1 与 factor 之间切换', () => {
	assert.equal(clickZoomTarget(1, 2), 2, '1× 点一下 → 放大到 2×');
	assert.equal(clickZoomTarget(2, 2), 1, '2× 点一下 → 回 1×（与 reveal.js 的 to()/out() 同语义）');
	// 判据是 `current === 1` 而不是「等于 factor」：任何不是 1 的当前值都算「已放大」，一律回 1。
	// 这条兜住「视图缩放被别的路径改过」的情况（例如以后加了倍数设置项）。
	assert.equal(clickZoomTarget(1.5, 2), 1);
});

test('elementPoint：屏幕坐标减去元素原点后，要除以当前倍数', () => {
	const rect = { left: 100, top: 50 };
	assert.deepEqual(elementPoint(300, 200, rect, 1), { x: 200, y: 150 }, '1× 时就是屏幕偏移');
	// transform-origin 在 0 0，所以 rect 左上角不随缩放移动；元素变成 2 倍大之后，
	// 同一段屏幕偏移只覆盖元素本地坐标的一半 —— 不除就会把锚点算到两倍远处。
	assert.deepEqual(
		elementPoint(300, 200, rect, 2),
		{ x: 100, y: 75 },
		'2× 时同一屏幕点对应的元素本地坐标减半',
	);
});

test('zoomScrollDelta：(s₂ − s₁) · p，放大是正向补偿、缩小是反向补偿', () => {
	const point = { x: 200, y: 150 };
	assert.deepEqual(
		zoomScrollDelta(1, 2, point),
		{ left: 200, top: 150 },
		'放大 → 内容要往右 / 往下多滚，点击点才会留在屏幕原位',
	);
	assert.deepEqual(
		zoomScrollDelta(2, 1, point),
		{ left: -200, top: -150 },
		'缩小 → 同一元素本地坐标下补偿方向相反',
	);
	assert.deepEqual(zoomScrollDelta(1, 1, point), { left: 0, top: 0 }, '倍数没变就不补偿');
});

test('viewportCenter：用 client 盒（不含边框与滚动条），中心在 clientLeft/Top + 一半宽高处', () => {
	const scroller = {
		getBoundingClientRect: () => ({ left: 100, top: 40 }),
		clientLeft: 2,
		clientTop: 3,
		clientWidth: 800,
		clientHeight: 600,
	};
	assert.deepEqual(
		viewportCenter(scroller),
		{ x: 502, y: 343 },
		'100 + 2 + 400 / 40 + 3 + 300 —— 边框内侧起算，宽高都不含滚动条',
	);
	// 边框为 0、无滚动条时（弹窗的常见情形）退化成「rect 左上角 + 一半尺寸」
	assert.deepEqual(
		viewportCenter({
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
			clientLeft: 0,
			clientTop: 0,
			clientWidth: 1481,
			clientHeight: 833,
		}),
		{ x: 740.5, y: 416.5 },
		'与真机实测的画布中心一致（Plan-20260920-161511 §2.1）',
	);
});

test('scrollToMove：内容是往右 / 下走，滚动量就要往反方向走（from − to）', () => {
	assert.deepEqual(
		scrollToMove({ x: 700, y: 380 }, { x: 740.5, y: 416.5 }),
		{ left: -40.5, top: -36.5 },
		'点击处要在中心左侧 → 滚动量是负的（往左滚，把内容推到右边）',
	);
	assert.deepEqual(
		scrollToMove({ x: 900, y: 700 }, { x: 740.5, y: 416.5 }),
		{ left: 159.5, top: 283.5 },
		'点击处已在中心右下 → 滚动量为正，把内容往左上带',
	);
	assert.deepEqual(scrollToMove({ x: 5, y: 5 }, { x: 5, y: 5 }), { left: 0, top: 0 }, '已在中心则不动');
});

test('两项补偿之和：先把点击处锚住，再把它推到画布中心', () => {
	// 真机场景（Plan-20260920-161511 §2.3）：点 (700, 300)、画布中心 (740.5, 416.5)
	const rect = { left: 60, top: -420 }; // 正文容器在点击那一刻的屏幕原点（示意值）
	const click = { x: 700, y: 300 };
	const center = { x: 740.5, y: 416.5 };
	const point = elementPoint(click.x, click.y, rect, 1);

	// 放大 + 滚动之后的屏幕位置：滚动把内容往左 / 上带（所以减滚动量），
	// 缩放则把元素本地坐标放大 s 倍后叠回原点。
	const screenAfter = (scale, scrollDelta) => ({
		x: rect.left - scrollDelta.left + scale * point.x,
		y: rect.top - scrollDelta.top + scale * point.y,
	});

	const delta = zoomScrollDelta(1, 2, point);
	const shift = scrollToMove(click, center);
	const landed = screenAfter(2, { left: delta.left + shift.left, top: delta.top + shift.top });
	assert.ok(
		Math.abs(landed.x - center.x) < 1e-9 && Math.abs(landed.y - center.y) < 1e-9,
		`两项之和应把点击处送到画布中心，实测落在 (${landed.x}, ${landed.y})`,
	);
	// 反例：只有 zoomScrollDelta（旧行为）时点击处原地不动，与中心差 (40.5, 36.5)px
	// —— 这正是被反馈的「放大后没到画布中间」（Plan-20260920-154434 §1 选定的「放大镜」语义）。
	assert.deepEqual(
		screenAfter(2, delta),
		click,
		'只有锚定项时点击处停在原屏幕位置，一步都没往中心挪',
	);
});
