/**
 * 弹窗样式回归用例 —— 目前只钉住「表格字号」这一条（V109 修复，2026-09-18）。
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
