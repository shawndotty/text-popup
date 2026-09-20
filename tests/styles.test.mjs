/**
 * 弹窗样式回归用例 —— 目前钉住两条：表格字号（V109 修复，2026-09-18）与视图缩放的 transform
 * （V116 第四次反馈「Zoom out 抖动」的修复，2026-09-20）。
 *
 * 背景：核心给单元格直接写了字号
 * （`.markdown-rendered td { font-size: var(--table-text-size) }`、
 *   `.markdown-rendered th { font-size: var(--table-header-size) }`），
 * 而这两个变量在 `:root` 就解析成了 `--font-text-size` 的当前值 —— 是**绝对像素**，
 * 不再随祖先的 `font-size` 变化。弹窗的「字号 / 缩放」只改 `--text-popup-font-size`
 * （见 modal.ts 的 updateSize），于是传不进单元格：真机实测弹窗正文 30px 时 th / td 仍是 16px。
 *
 * styles.css 里那条 `font-size: inherit` 是唯一修复点，删掉它 bug 会静默回来；
 * 本仓库没有能跑真实样式的 DOM 环境（`tests/convert.test.mjs` 覆盖的是转换逻辑），
 * 所以用最小代价把这把尺子钉住：
 *   ① 单元格必须跟随弹窗字号；
 *   ② 这条覆盖必须限定在弹窗内 —— 真机实测编辑器 / 阅读视图里的表格应由 App 正文字号决定（16px），
 *      丢了这个作用域就会把它们一起改掉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** styles.css 里目前没有 @media / @supports，展平解析即可。 */
const CSS = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
	// 先去注释：注释里也会出现 `font-size: inherit` 这样的字面量
	.replace(/\/\*[\s\S]*?\*\//g, '');

/** 全部 `选择器 { 声明 }` 规则。 */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList, body]) => ({
	selectors: selectorList.split(',').map((selector) => selector.trim()),
	body: body.trim(),
}));

/** 把字号交还给继承的两种等价写法。 */
const FOLLOWS_POPUP_SIZE = /font-size\s*:\s*(inherit|var\(\s*--text-popup-font-size\s*\))/;

/** 选择器里是否出现标签 `tag` 这个 token（`td` 命中 `td:hover`，不命中 `.td-x`）。 */
function hasTagToken(selector, tag) {
	return new RegExp(`(^|[\\s>+~,(])${tag}(?![\\w-])`).test(selector);
}

test('弹窗内的表格单元格跟随弹窗字号：th 与 td 各有一条覆盖', () => {
	for (const cell of ['th', 'td']) {
		const hit = RULES.some(
			(rule) =>
				FOLLOWS_POPUP_SIZE.test(rule.body) &&
				rule.selectors.some(
					(selector) => selector.includes('.mod-text-popup') && hasTagToken(selector, cell),
				),
		);
		assert.ok(
			hit,
			`styles.css 缺少弹窗内 \`${cell}\` 的字号覆盖，表格文字会退回 App 正文字号（--font-text-size）`,
		);
	}
});

test('单元格字号覆盖必须限定在弹窗内，不能影响编辑器与阅读视图', () => {
	const leaked = RULES.filter((rule) =>
		rule.selectors.some(
			(selector) => hasTagToken(selector, 'th') || hasTagToken(selector, 'td'),
		),
	).filter((rule) => rule.selectors.some((selector) => !selector.includes('.mod-text-popup')));

	assert.deepEqual(
		leaked.map((rule) => rule.selectors.join(', ')),
		[],
		'styles.css 里出现了不带 .mod-text-popup 作用域的 th / td 规则，会波及编辑器与阅读视图',
	);
});

/**
 * 视图缩放那条 transform 必须同时挂上平移补偿，而且 `translate` 要写在 `scale` **左边**。
 *
 * 滚动量是会被浏览器夹住的量：内容块比画布窄的那条轴上，可滚区间会随着缩小塌到 0，被夹掉的那一截
 * 只能由 transform 的平移顶上（见 modal.ts 的 panCompensation）。两个坑都在这条断言里：
 *   ① 删掉 translate 会让 Zoom out 的抖动静默回来（真机实测横向甩回 101px，Report-20260920-202610）；
 *   ② transform 从右往左作用，写成 `scale() translate()` 时平移量会被 scale 放大，补偿的数值全错。
 */
test('视图缩放的 transform 同时挂 scale 与平移补偿，且 translate 在 scale 左边', () => {
	const rule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) => selector.includes('.is-view-zoomed') && selector.includes('.text-popup-text'),
			) && /transform\s*:/.test(entry.body),
	);
	assert.ok(rule, 'styles.css 里找不到 `.is-view-zoomed .text-popup-text` 的 transform 规则');

	const transform = rule.body.slice(rule.body.indexOf('transform:'));
	const translate = transform.slice(transform.indexOf('translate('), transform.indexOf('scale('));
	assert.ok(
		/--text-popup-pan-x/.test(translate),
		'translate 里缺少 --text-popup-pan-x：滚动被夹住时内容会被钉住、再随 scale 反向甩回',
	);
	assert.ok(/--text-popup-pan-y/.test(translate), 'translate 里缺少 --text-popup-pan-y（纵轴同样会被夹）');
	assert.ok(
		/scale\(\s*var\(\s*--text-popup-view-scale/.test(transform),
		'transform 缺少 --text-popup-view-scale 的缩放',
	);
	assert.ok(
		0 < transform.indexOf('translate(') && transform.indexOf('translate(') < transform.indexOf('scale('),
		'translate 必须写在 scale 左边：transform 从右往左作用，落到缩放结果上才是屏幕像素',
	);
	assert.ok(
		/transform-origin\s*:\s*0\s+0/.test(rule.body),
		'transform-origin 必须留在 0 0（点击处左上方的内容要能滚回来，见 styles.css 的注释）',
	);
});
