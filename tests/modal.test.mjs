/**
 * `modal.ts` 里 `headingColorVariables` 的行为用例 —— V109「弹窗标题色不跟随主题」修复（2026-09-18）。
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
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const { headingColorVariables } = await jiti.import('../src/modal.ts');

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
