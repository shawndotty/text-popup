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
 *
 * ④ `easeOutCubic` / `zoomTweenFrame` —— V116 第三次反馈「给 Zoom in / Zoom out 加 transition」
 * （2026-09-20）。这里钉住两件事：端点是精确的起止值（不能欠一点或多一点），以及**中间帧的
 * scale 与滚动必须同进度** —— 那正是「被锚定的点沿直线滑到画布中心」的充要条件（推导见
 * `zoomTweenFrame` 的注释）。帧率是否真的够平滑、有没有掉帧只能真机量
 * （见 Report-20260920-184458）。
 *
 * ⑤ `resolveViewFrame` —— V116 第四次反馈「Zoom out 有比较明显的抖动」（2026-09-20）。
 * 抖动来自滚动被浏览器夹住：内容块比画布窄的那条轴上，可滚区间会随着缩小塌到 0，写进去的滚动量
 * 不再生效，`zoomTweenFrame` 那条直线于是断掉，内容先被钉住、再随 scale 反向甩回来（真机实测
 * 横向甩回 101px，见 Report-20260920-202610 §3）。这里钉住补偿的两个分支与两个端点，
 * 并用真机那组几何跑一遍「夹取 vs 补偿」的对照（不补偿必须出现反向，补偿后必须单调）。
 *
 * ⑥ `wheelZoomTarget` —— V119「按住 Ctrl / Command 滚轮缩放」（2026-09-22，
 * 方案 [[Plan-20260922-212757]] §3.1）。算式逐条照抄核心 `handleWheelZoom`
 * （`-deltaY/150`、`deltaMode` 折算 40/800、macOS 非整数 deltaY 翻倍、`clamp(z, 1, 10)`）。
 * 这里钉住四档读数（含 deltaY = 0）；「锚点是否真的不漂移」取决于真实布局与滚动夹取，
 * 只能真机 eval 量（基线见该方案 §3.3：误差 ≤ 0.2px）。
 *
 * ⑦ `settleZoomFrame` —— V119 跟进「滚轮缩放时文字 / Excalidraw / Canvas 会抖，图片却不抖」
 * （2026-09-23，方案 [[Plan-20260923-055530]]）。同一条锚点补偿在单帧版里漏了「上一格留下的平移」，
 * 每格跳一次、跳的距离精确等于上一格的 pan —— 只在「内容放大后仍装得下」的轴上现形，图片因为
 * 恰好铺满一屏、补偿全由滚动承担，所以观感上不抖。这里钉住「放得下 → 滚动全担 / 放不下 → 滚动写 0、
 * 整段交给平移」这两个分支，以及两分支的落位必须一致；「判据 `q` 逐格恒定」只能真机量。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	clampScroll,
	clickZoomTarget,
	easeOutCubic,
	elementPoint,
	headingColorVariables,
	resolveViewFrame,
	scrollToMove,
	settleZoomFrame,
	viewportCenter,
	wheelZoomTarget,
	zoomScrollDelta,
	zoomTweenFrame,
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

test('easeOutCubic：端点为 0 / 1，越界夹取，前半程走得更快', () => {
	assert.equal(easeOutCubic(0), 0, '起点必须精确为 0，否则第一帧就跳一下');
	assert.equal(easeOutCubic(1), 1, '终点必须精确为 1，否则收尾要再补一次跳变');
	assert.equal(easeOutCubic(-0.2), 0, 'rAF 时间戳理论上不会倒退，但夹住更省心');
	assert.equal(easeOutCubic(1.4), 1, '最后一帧可能略微超时，不能算出 >1 的进度再回弹');
	assert.ok(easeOutCubic(0.5) > 0.5, 'ease-**out**：一半时间要走过一半以上路程（起步快、收尾慢）');
	// 单调递增是「不能中途倒退」的形式化版本
	let previous = -1;
	for (let i = 0; i <= 20; i++) {
		const value = easeOutCubic(i / 20);
		assert.ok(value >= previous, `progress=${i / 20} 时进度回退了：${value} < ${previous}`);
		previous = value;
	}
});

test('zoomTweenFrame：progress 0 / 1 就是精确的起点与终点', () => {
	const tween = {
		fromScale: 1,
		toScale: 2,
		fromScroll: { left: 120, top: 340 },
		toScroll: { left: 520, top: 840 },
	};
	assert.deepEqual(
		zoomTweenFrame(tween, 0),
		{ scale: 1, scroll: { left: 120, top: 340 } },
		'progress=0 必须等于当前状态，不然点下去第一帧就会跳',
	);
	assert.deepEqual(
		zoomTweenFrame(tween, 1),
		{ scale: 2, scroll: { left: 520, top: 840 } },
		'progress=1 必须精确落在目标上（收尾那一帧还会再写一次精确值）',
	);
	assert.deepEqual(zoomTweenFrame(tween, 9), zoomTweenFrame(tween, 1), '越界的 progress 夹到 1');
});

test('zoomTweenFrame：scale 与滚动共用同一条缓动曲线（同进度的形式化判据）', () => {
	const tween = {
		fromScale: 1,
		toScale: 2,
		fromScroll: { left: -300, top: 50 },
		toScroll: { left: 700, top: -250 },
	};
	for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
		const { scale, scroll } = zoomTweenFrame(tween, progress);
		// 各自归一化到 [0, 1] 之后必须相等：任何一项自己走另一条时间线都会在这里露馅
		assert.ok(
			Math.abs(scale - 1 - easeOutCubic(progress)) < 1e-12 &&
				Math.abs((scroll.left + 300) / 1000 - easeOutCubic(progress)) < 1e-12 &&
				Math.abs((scroll.top - 50) / -300 - easeOutCubic(progress)) < 1e-12,
			`progress=${progress} 时 scale 与滚动的进度不一致`,
		);
	}
});

test('中间的每一帧都把被锚定的点留在「点击处 → 画布中心」这条直线上', () => {
	// 与上一条同一个真机场景（Plan-20260920-161511 §2.3）：点 (700, 300)、画布中心 (740.5, 416.5)
	const rect = { left: 60, top: -420 };
	const click = { x: 700, y: 300 };
	const center = { x: 740.5, y: 416.5 };
	const point = elementPoint(click.x, click.y, rect, 1);

	// 起点滚动量取 0（等价于「把元素原点当作滚动原点」，只影响 rect 的取值，不影响结论）
	const tween = {
		fromScale: 1,
		toScale: 2,
		fromScroll: { left: 0, top: 0 },
		toScroll: zoomScrollDelta(1, 2, point),
	};
	tween.toScroll = {
		left: tween.toScroll.left + scrollToMove(click, center).left,
		top: tween.toScroll.top + scrollToMove(click, center).top,
	};

	const screenOf = (scale, scroll) => ({
		x: rect.left - scroll.left + scale * point.x,
		y: rect.top - scroll.top + scale * point.y,
	});

	for (const progress of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
		const { scale, scroll } = zoomTweenFrame(tween, progress);
		const landed = screenOf(scale, scroll);
		// 期望轨迹：点击处 → 画布中心的直线，进度同样是 easeOutCubic
		const e = easeOutCubic(progress);
		const expected = { x: click.x + e * (center.x - click.x), y: click.y + e * (center.y - click.y) };
		assert.ok(
			Math.abs(landed.x - expected.x) < 1e-9 && Math.abs(landed.y - expected.y) < 1e-9,
			`progress=${progress} 时锚点跑偏：落在 (${landed.x}, ${landed.y})，应在 (${expected.x}, ${expected.y})`,
		);
	}
});

test('反例：scale 与滚动各走各的时间线时，锚点会脱轨', () => {
	// 「只给 transform 加 CSS transition、滚动瞬间到位」就是这种情形 —— 起步那一帧拉出来看
	const rect = { left: 60, top: -420 };
	const click = { x: 700, y: 300 };
	const point = elementPoint(click.x, click.y, rect, 1);
	const scroll = {
		left: zoomScrollDelta(1, 2, point).left + scrollToMove(click, { x: 740.5, y: 416.5 }).left,
		top: zoomScrollDelta(1, 2, point).top + scrollToMove(click, { x: 740.5, y: 416.5 }).top,
	};
	// scale 还在起点 1（过渡刚开始），滚动却已经到位：锚点被甩到别处，画面上就是「先跳一下再缩放」
	const jumped = { x: rect.left - scroll.left + 1 * point.x, y: rect.top - scroll.top + 1 * point.y };
	assert.ok(
		Math.hypot(jumped.x - click.x, jumped.y - click.y) > 10,
		`时间线错开时锚点应当明显离开点击处，实测只偏了 ${Math.hypot(jumped.x - click.x, jumped.y - click.y)}px`,
	);
});

const NO_PAN = { left: 0, top: 0 };

test('resolveViewFrame：没被夹时滚动全担，收尾必须是干净的 transform', () => {
	const desired = { left: 875, top: 519 };
	for (const progress of [0, 0.5, 1]) {
		const frame = resolveViewFrame(desired, desired, NO_PAN, progress);
		assert.deepEqual(frame.scroll, desired, `progress=${progress} 时滚动量应当原样写下去`);
		assert.deepEqual(frame.pan, NO_PAN, `progress=${progress} 时不该有平移：没被夹就不该动内容`);
	}
});

test('resolveViewFrame：被夹掉时滚动写 0、整段交给平移（平移会再把滚动夹一次，只能这么做）', () => {
	// 真机实测：平移到 −200 之后，原本 875 的滚动会被浏览器夹到 674.8 —— 所以「滚动担一部分、
	// 平移补一部分」解不出来，滚动必须写 0（0 永远合法、不会再被夹）。
	const desired = { left: 300, top: 0 };
	const accepted = { left: 0, top: 0 };
	const frame = resolveViewFrame(desired, accepted, NO_PAN, 0.5);
	assert.deepEqual(frame.scroll, NO_PAN, '放不下时滚动归 0，不能留在被夹后的那个值上');
	assert.equal(frame.pan.left, -300, '差额必须由平移顶上（负值 = 让 transform 再往左推 300px）');
	// 屏幕落位 = 原点 − 滚动 + 平移，两种分支下都必须等于 原点 − 目标
	const landed = (f, origin) => origin - f.scroll.left + f.pan.left;
	assert.equal(landed(frame, 1000), landed({ scroll: desired, pan: NO_PAN }, 1000), '两种分支的落位必须一致，否则边界会跳');
});

test('resolveViewFrame：上一段过渡的残留按进度收回，最后一帧必须归零', () => {
	// 入参是**缓动后**的进度（与 scale / 滚动同一条曲线，调用方传 easeOutCubic 的结果）
	const carry = { left: -164, top: -20 };
	const fits = (eased) => resolveViewFrame(NO_PAN, NO_PAN, carry, eased).pan;
	assert.equal(fits(0).left, -164, '进度 0 时残留在原位 —— 打断那一刻画面不能动');
	assert.equal(fits(0.5).left, -82, '中途按同一进度收回');
	// 用 `=== 0` 而不是 assert.equal：`-164 * 0` 是 -0，写进 CSS 就是 `0px`，语义上等价
	assert.ok(fits(1).left === 0, '收尾必须收到 0，否则会留下永久位移');
	assert.ok(fits(9).left === 0, '越界的进度也要夹住');
});

test('resolveViewFrame：读数只差零点几像素（设备像素对齐）时仍算「放得下」，分支不能来回翻', () => {
	// 真机实测：DPR 1.728 时滚动位置按设备像素对齐，1 设备像素 ≈ 0.58px，读回来常比目标小一点
	const desired = { left: 479.75, top: 0 };
	const accepted = { left: 479.17199999999997, top: 0 };
	const frame = resolveViewFrame(desired, accepted, NO_PAN, 0.5);
	assert.deepEqual(frame.scroll, desired, '差不到 1px 应当照旧走「滚动全担」，否则滚动量会无谓地在 0 与目标间跳');
	assert.deepEqual(frame.pan, NO_PAN, '这种量级不该动用平移');
});

test('clampScroll：目标夹进可达范围，够得着的不动、下限是 0', () => {
	// 真机实测（Report-20260920-223435 §3）：内容块 1077 宽、画布 1481，点击落在画布左侧时
	// 算出来的横向目标是 1191，而 2× 的上限只有 875。
	assert.deepEqual(
		clampScroll({ left: 1191, top: 103 }, { left: 875, top: 10798 }),
		{ left: 875, top: 103 },
		'超上限的轴夹到上限，没超的原样保留',
	);
	assert.deepEqual(clampScroll({ left: -40, top: 0 }, { left: 875, top: 0 }), { left: 0, top: 0 }, '负值夹到 0');
	// 横向在 1× 时根本滚不动（上限 0）：这一轴的目标只能是 0，内容不该横向平移
	assert.deepEqual(clampScroll({ left: 538, top: 12 }, { left: 0, top: 0 }), { left: 0, top: 0 }, '上限为 0 时两轴都归 0');
});

test('Zoom in：滚动被夹住时平移接手，内容不再先朝反方向漂出去', () => {
	// 与真机同一组几何（Report-20260920-223435 §3）：内容块 1077.07 宽、居中在 1481.48 的画布里。
	// 横向可滚区间 = 内容块超出可视区的那部分，要放大到 scale≈1.19 才从 0 冒出来 —— 前几帧的滚动
	// 于是被钉在 0，而 scale 一涨、锚点就朝反方向漂出去（真机实测 155px），再被追回来。
	const originX = 202.21;
	const extentX = 1077.07;
	const viewport = 1481.48;
	const limit = (scale) => Math.max(0, originX + extentX * scale - viewport);
	/** 点击处（点击点在 `.text-popup-text` 内的横坐标）在屏幕上的位置。 */
	const clickLocalX = 864.79;
	const pointX = (frame, scale) => originX - frame.scroll.left + frame.pan.left + scale * clickLocalX;
	// 目标来自 zoomScrollDelta + scrollToMove：锚住点击处（+864.79），再把它推到画布中心（再 +326.5）
	const ideal = { left: 864.79 + 326.5, top: 0 };
	const tween = {
		fromScale: 1,
		toScale: 2,
		fromScroll: { left: 0, top: 0 },
		toScroll: clampScroll(ideal, { left: limit(2), top: Infinity }),
	};
	assert.equal(tween.toScroll.left, limit(2), '这组几何下目标本身就够不着，必须夹到上限');

	const plain = [];
	const compensated = [];
	for (let i = 0; i <= 10; i++) {
		const progress = i / 10;
		const { scale, scroll } = zoomTweenFrame(tween, progress);
		// 真机实测：写进去的滚动量会被同步夹进 [0, limit(scale)]，读回来就是这个值
		const accepted = { left: Math.min(scroll.left, limit(scale)), top: 0 };
		plain.push(pointX({ scroll: accepted, pan: NO_PAN }, scale));
		compensated.push(pointX(resolveViewFrame(scroll, accepted, NO_PAN, easeOutCubic(progress)), scale));
	}

	// 补偿后每一帧都精确落在「没有夹取」那条直线上（这才是 zoomTweenFrame 承诺的东西）
	for (let i = 0; i <= 10; i++) {
		const { scale, scroll } = zoomTweenFrame(tween, i / 10);
		const straight = pointX({ scroll, pan: NO_PAN }, scale);
		assert.ok(
			Math.abs(compensated[i] - straight) < 1e-9,
			`progress=${i / 10} 时补偿后仍偏离直线 ${compensated[i] - straight}px`,
		);
	}
	assert.ok(
		compensated.every((value, i) => i === 0 || value <= compensated[i - 1]),
		`补偿后点击处应当单调地滑向落点，不能中途反向；实测轨迹 ${compensated.map((v) => v.toFixed(1)).join(' → ')}`,
	);

	// 不做补偿时：内容先朝反方向漂出去、再被追回来 —— 就是用户看到的「Zoom in 抖动」
	const drift = Math.max(...plain) - plain[0];
	assert.ok(drift > 50, `不补偿时反向漂出的量应当明显可见，实测只有 ${drift.toFixed(1)}px`);
	assert.ok(
		plain.some((value, i) => i > 0 && value < plain[i - 1]),
		'这组几何下不补偿应当出现反向，否则这条用例失去了意义',
	);
});

test('Zoom out：滚动被夹住时平移接手，内容仍走直线（不补偿则反向甩回）', () => {
	// 与真机同一组几何（Report-20260920-202610 §3）：内容块 1077.07 宽、居中在 1481.48 的画布里。
	// 可滚区间 = 内容块超出可视区的那部分，缩小到 scale≈1.19 就塌成 0 —— 这就是夹取的来源。
	const originX = 202.21;
	const extentX = 1077.07;
	const viewport = 1481.48;
	const limit = (scale) => Math.max(0, originX + extentX * scale - viewport);
	// 从 2× 的落点（已贴着上限）回到 1× 的原位
	const tween = {
		fromScale: 2,
		toScale: 1,
		fromScroll: { left: 875, top: 0 },
		toScroll: { left: 0, top: 0 },
	};
	/** 内容块中心在屏幕上的位置：原点 − 滚动 + 平移 + scale × 半宽。 */
	const centerX = (frame, scale) => originX - frame.scroll.left + frame.pan.left + (scale * extentX) / 2;

	const plain = [];
	const compensated = [];
	for (let i = 0; i <= 10; i++) {
		const progress = i / 10;
		const { scale, scroll } = zoomTweenFrame(tween, progress);
		// 真机实测：写进去的滚动量会被同步夹进 [0, limit(scale)]，读回来就是这个值
		const accepted = { left: Math.min(scroll.left, limit(scale)), top: 0 };
		plain.push(centerX({ scroll: accepted, pan: NO_PAN }, scale));
		compensated.push(centerX(resolveViewFrame(scroll, accepted, NO_PAN, easeOutCubic(progress)), scale));
	}

	// 补偿后每一帧都精确落在「没有夹取」那条直线上（这才是 zoomTweenFrame 承诺的东西）
	for (let i = 0; i <= 10; i++) {
		const { scale, scroll } = zoomTweenFrame(tween, i / 10);
		const straight = centerX({ scroll, pan: NO_PAN }, scale);
		assert.ok(
			Math.abs(compensated[i] - straight) < 1e-9,
			`progress=${i / 10} 时补偿后仍偏离直线 ${compensated[i] - straight}px`,
		);
	}
	assert.ok(
		compensated.every((value, i) => i === 0 || value >= compensated[i - 1]),
		'补偿后内容应当单调地滑向落点，不能中途反向',
	);

	// 不做补偿时：内容先被钉住、再随 scale 反向甩回来 —— 就是用户看到的「Zoom out 抖动」
	assert.ok(
		plain.some((value, i) => i > 0 && value < plain[i - 1]),
		'这组几何下不补偿应当出现反向，否则这条用例失去了意义',
	);
	const swingBack = Math.max(...plain) - plain[plain.length - 1];
	assert.ok(swingBack > 50, `不补偿时甩回量应当明显可见，实测只有 ${swingBack.toFixed(1)}px`);
});

test('打断：残留的收回与缩放走同一条缓动曲线，内容不会反向', () => {
	// 真机场景（Report-20260920-202610 §4）：从 2× 往 1× 收的途中又 Alt+点一下，新过渡的起点就是
	// 当时的真实状态 —— 此时平移里还压着 212px 没收回，它必须在这次过渡里按**同一条曲线**收完。
	const originX = 202.21;
	const extentX = 1077.07;
	const carry = { left: -212, top: 0 };
	const tween = {
		fromScale: 1.2423,
		toScale: 1,
		fromScroll: { left: 0, top: 0 },
		toScroll: { left: 0, top: 0 },
	};
	const series = [];
	for (let i = 0; i <= 10; i++) {
		const progress = i / 10;
		const { scale, scroll } = zoomTweenFrame(tween, progress);
		const frame = resolveViewFrame(scroll, scroll, carry, easeOutCubic(progress));
		series.push(originX - frame.scroll.left + frame.pan.left + (scale * extentX) / 2);
	}
	assert.ok(
		series.every((value, i) => i === 0 || value >= series[i - 1]),
		`残留若按原始进度收回（与缩放错开），内容会先反向漂一下；实测轨迹 ${series.map((v) => v.toFixed(1)).join(' → ')}`,
	);
});

test('滚轮缩放：步长、macOS 非整数翻倍、上下限、deltaMode 折算', () => {
	// 鼠标滚轮一格（整数 deltaY，不翻倍）：±100 / 150
	assert.equal(
		wheelZoomTarget(1, -100, 0, false),
		1 + 100 / 150,
		'整数 deltaY 不翻倍，否则手感会比内置图片查看器快一倍',
	);

	// 触控板一帧（非整数 deltaY）在 macOS 上翻倍：与核心 `rd.isMacOS && !Number.isInteger(e.deltaY)` 对齐
	const trackpad = wheelZoomTarget(1, -3.5, 0, true) - 1;
	assert.ok(
		Math.abs(trackpad - 2 * (3.5 / 150)) < 1e-12,
		`macOS 上非整数 deltaY 的步长应当翻倍，实测 ${trackpad}`,
	);
	assert.ok(
		Math.abs(wheelZoomTarget(1, -3.5, 0, false) - 1 - 3.5 / 150) < 1e-12,
		'非 macOS 上同样的 deltaY 不翻倍',
	);

	// 上下限 [1, 10]：往下滚到下限就停（缩到 1× 之下只剩白边），往上到上限就停
	assert.equal(wheelZoomTarget(1, 120, 0, false), 1);
	assert.equal(wheelZoomTarget(10, -100, 0, false), 10);

	// Electron 里量不到这两个 deltaMode，只能靠单测钉住与核心逐字对齐的折算率
	assert.equal(wheelZoomTarget(2, -100, 1, false), 10, 'DOM_DELTA_LINE 按 40px/行折算');
	assert.equal(wheelZoomTarget(2, 100, 2, false), 1, 'DOM_DELTA_PAGE 按 800px/页折算');

	// 某些设备会派 deltaY = 0 的 wheel（横向滚动），不能让它把倍数推走
	assert.equal(wheelZoomTarget(1.6, 0, 0, false), 1.6);
});

test('settleZoomFrame：放得下时滚动全担、平移清零（平移是用户滚不回来的量，能不用就不用）', () => {
	const frame = settleZoomFrame({ left: 300, top: 0 }, { left: 875, top: 519 });
	assert.deepEqual(frame.scroll, { left: 300, top: 0 }, '放得下就整段写成滚动量');
	assert.deepEqual(frame.pan, NO_PAN, '滚动担得下时不该动用平移');
	// 边界（`need` 正好等于上限）仍走滚动分支：两种分支的屏幕落位相同，但只有滚动是能回滚的
	const edge = settleZoomFrame({ left: 875, top: 519 }, { left: 875, top: 519 });
	assert.deepEqual(edge.scroll, { left: 875, top: 519 }, 'need == limit 时仍算放得下');
	assert.deepEqual(edge.pan, NO_PAN, '边界上也不该动用平移');
});

test('settleZoomFrame：放不下 / 需要反向位移时滚动写 0、整段交给平移', () => {
	// 真机实测（Plan-20260920-161511 §2.2）：点击落在画布左侧要 1191，而 2× 的上限只有 875
	const over = settleZoomFrame({ left: 1191, top: 0 }, { left: 875, top: 0 });
	assert.deepEqual(over.scroll, NO_PAN, '放不下时滚动写 0 —— 写进去也会被再夹一次');
	assert.deepEqual(over.pan, { left: -1191, top: 0 }, '整段由平移顶上，屏幕落位不变');
	// 缩小时 need 会变负：内容比画布小、缩放把锚点往回拉，负的滚动写不进去，只能靠平移
	const backwards = settleZoomFrame({ left: -183.76, top: 0 }, { left: 0, top: 0 });
	assert.deepEqual(backwards.scroll, NO_PAN, '反向位移同样只能交给平移');
	assert.equal(backwards.pan.left, 183.76, '平移取反：屏幕坐标 = 原点 − 滚动 + 平移');
});

test('settleZoomFrame：两种分支的落位必须一致（pan − scroll 恒等于 −need）', () => {
	const limit = { left: 875, top: 519 };
	for (const value of [-183.76, 0, 37.86, 875, 1191]) {
		const { scroll, pan } = settleZoomFrame({ left: value, top: value }, limit);
		// 恒等式写成「差再补回去等于 0」：`need = 0` 时 `-0` 与 `0` 的严格相等会白白失败
		assert.ok(
			Math.abs(pan.left - scroll.left + value) < 1e-9,
			`need=${value} 时横向落位偏了 ${pan.left - scroll.left + value}px`,
		);
		assert.ok(
			Math.abs(pan.top - scroll.top + value) < 1e-9,
			`need=${value} 时纵向落位偏了 ${pan.top - scroll.top + value}px`,
		);
	}
});

test('滚轮缩放：连续多格后锚点仍钉在原处（漏掉 carry 则每格跳一次）', () => {
	// 与真机同一组几何（Plan-20260923-055530 §1.3 文字那一条）：内容块 1353.5 × 96，纵向居中在
	// 833 高的画布里（上下各留 304 空白），指针固定在 P = (740, 416)。纵向「放大后仍装得下」
	// → 补偿只能靠平移 → 正是会抖的那条轴；横向内容本来就比画布宽，全程走滚动分支。
	const origin = { x: 63.99, y: 368.67 };
	const extent = { x: 1353.5, y: 96 };
	const viewport = { x: 1481, y: 833 };
	const pointer = { x: 740, y: 416 };
	/** 可滚区间 = 内容块超出画布的那部分（居中那半边的空白不算，见 reachableScroll）。 */
	const limit = (scale) => ({
		left: Math.max(0, origin.x + extent.x * scale - viewport.x),
		top: Math.max(0, origin.y + extent.y * scale - viewport.y),
	});
	/** 浏览器只认 [0, limit] 里的滚动量，写进去的值会被同步夹一次。 */
	const accept = (value, axis, scale) => Math.min(Math.max(value, 0), limit(scale)[axis]);
	/** 缩放层原点在屏幕上的位置：布局原点 − 滚动 + 平移。 */
	const rectOf = (scroll, pan) => ({
		left: origin.x - scroll.left + pan.left,
		top: origin.y - scroll.top + pan.top,
	});
	/** 指针下压着的「内容局部坐标」：它恒定 = 没抖，它变了 = 内容在屏幕上平移了 Δq × scale。 */
	const anchor = (scale, scroll, pan) => {
		const rect = rectOf(scroll, pan);
		return { x: (pointer.x - rect.left) / scale, y: (pointer.y - rect.top) / scale };
	};

	/** 一格滚轮：照 zoomAtPoint 的顺序算出补偿并落位，返回新状态。 */
	const step = (state, settle) => {
		const current = state.scale;
		const point = elementPoint(pointer.x, pointer.y, rectOf(state.scroll, state.pan), current);
		const next = wheelZoomTarget(current, -120, 0, false);
		const delta = zoomScrollDelta(current, next, point);
		const desired = { left: state.scroll.left + delta.left, top: state.scroll.top + delta.top };
		const frame = settle(desired, state.pan, next);
		return {
			scale: next,
			scroll: {
				left: accept(frame.scroll.left, 'left', next),
				top: accept(frame.scroll.top, 'top', next),
			},
			pan: frame.pan,
		};
	};
	/** 走 6 格，返回逐格的锚点局部坐标。 */
	const run = (settle) => {
		const series = [];
		let state = { scale: 1, scroll: { left: 0, top: 0 }, pan: { left: 0, top: 0 } };
		for (let i = 0; i <= 6; i++) {
			series.push({ scale: state.scale, ...anchor(state.scale, state.scroll, state.pan) });
			if (i < 6) state = step(state, settle);
		}
		return series;
	};

	// 修好后：上一格留下的平移先从总位移里扣掉，再按可达上限二选一
	const fixed = (desired, carry, next) =>
		settleZoomFrame({ left: desired.left - carry.left, top: desired.top - carry.top }, limit(next));
	// 修复前：落位前先把平移归零，`carry` 于是恒为 0，只有被夹掉的那一段才交给平移
	const broken = (desired, _carry, next) => {
		const accepted = { left: accept(desired.left, 'left', next), top: accept(desired.top, 'top', next) };
		return resolveViewFrame(desired, accepted, NO_PAN, 0);
	};

	const after = run(fixed);
	for (const frame of after) {
		assert.ok(
			Math.abs(frame.y - after[0].y) < 0.2,
			`修好后纵向锚点不该动：${after[0].scale}× 时 q=${after[0].y}，${frame.scale}× 时成了 ${frame.y}`,
		);
		assert.ok(
			Math.abs(frame.x - after[0].x) < 0.2,
			`修好后横向锚点不该动：${after[0].scale}× 时 q=${after[0].x}，${frame.scale}× 时成了 ${frame.x}`,
		);
	}

	// 漏掉 carry 时：每格跳一次，跳的距离精确等于上一格的平移 —— 就是用户看到的抖动
	const before = run(broken);
	const drift = Math.max(
		...before.map((frame) => Math.abs(frame.y - before[0].y) * frame.scale),
	);
	assert.ok(
		drift > 20,
		`漏掉 carry 时纵向应当明显可见地跳（实测最大 ${drift.toFixed(1)}px），否则这条用例失去了意义`,
	);
});
