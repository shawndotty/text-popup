/**
 * `settings.ts` 的行为用例 —— 磁盘数据 → 完整设置的归一化。
 *
 * 这里守的是「老 `data.json` 不需要迁移脚本」这条承诺：任何字段缺失 / 类型不对 / 越界，
 * 都必须回落成一份能直接用的完整设置，而不是让插件带着 `undefined` 跑起来。
 *
 * 需要 obsidian 桩：`settings.ts` 是设置页所在模块，运行时会 `extends PluginSettingTab`，
 * 且**传递依赖** `scanner.ts` → `modal.ts`（因此桩必须覆盖那两处用到的符号，见 tests/stubs/）。
 *
 * 刻意没测：`TextPopupSettingTab` 的 DOM 渲染与交互（需要真实 DOM 与 Obsidian 设置页容器）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const { DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN, normalizeSettings, resolvePopupTag } =
	await jiti.import('../src/settings.ts');

// —— 默认值与老数据 ——

test('空数据归一化为完整默认设置', () => {
	assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS, 'undefined');
	assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS, 'null');
	assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS, '空对象');
});

test('老 data.json 缺 blockKinds / popupTag 时逐项补齐', () => {
	const settings = normalizeSettings({ enabled: false, popupFontSize: 20 });
	assert.deepEqual(settings.blockKinds, DEFAULT_SETTINGS.blockKinds, 'blockKinds 补齐');
	assert.equal(settings.popupTag, 'div', 'popupTag 补齐');
	assert.deepEqual(settings.supportedTags, ['div', 'p'], 'supportedTags 补齐');
	assert.equal(settings.enabled, false, '已有字段保留');
	assert.equal(settings.popupFontSize, 20, '已有字段保留');
});

test('blockKinds 缺键时逐键回落，已有的键保留', () => {
	const settings = normalizeSettings({ blockKinds: { math: false } });
	assert.deepEqual(settings.blockKinds, { code: true, callout: true, math: false });
});

// —— 数值回落 ——

test('字号越界被 clamp 到上下限', () => {
	assert.equal(normalizeSettings({ popupFontSize: 5 }).popupFontSize, FONT_SIZE_MIN, '过小');
	assert.equal(normalizeSettings({ popupFontSize: 100 }).popupFontSize, FONT_SIZE_MAX, '过大');
});

test('字号小数被四舍五入', () => {
	assert.equal(normalizeSettings({ popupFontSize: 16.4 }).popupFontSize, 16, '16.4');
	assert.equal(normalizeSettings({ popupFontSize: 16.6 }).popupFontSize, 17, '16.6');
});

test('字号非数字 / 非有限值回落默认 16', () => {
	assert.equal(normalizeSettings({ popupFontSize: '20' }).popupFontSize, 16, '字符串');
	assert.equal(normalizeSettings({ popupFontSize: Number.NaN }).popupFontSize, 16, 'NaN');
	assert.equal(normalizeSettings({ popupFontSize: Number.POSITIVE_INFINITY }).popupFontSize, 16, 'Infinity');
});

// —— 类型回落 ——

test('非布尔的开关回落默认值', () => {
	assert.equal(normalizeSettings({ enabled: 'false' }).enabled, true, '字符串 "false"');
	assert.equal(normalizeSettings({ renderRichText: 0 }).renderRichText, true, '数字 0');
});

test('非字符串的颜色值回落为空串（跟随主题）', () => {
	assert.equal(normalizeSettings({ popupBackgroundColor: 123 }).popupBackgroundColor, '', '数字');
	assert.equal(normalizeSettings({ popupTextColor: null }).popupTextColor, '', 'null');
});

test('颜色值为字符串时原样保留', () => {
	assert.equal(normalizeSettings({ popupBackgroundColor: '#2b2b2b' }).popupBackgroundColor, '#2b2b2b');
});

// —— 包裹标签的约束式回落 ——

test('行内标签不能当包裹标签，回落到列表里第一个块级标签', () => {
	assert.equal(resolvePopupTag('span', ['div', 'span']), 'div', 'span 被挤掉');
});

test('包裹标签不在支持列表里时，取列表里第一个块级标签', () => {
	assert.equal(resolvePopupTag('section', ['div', 'p']), 'div', '不在列表');
	assert.equal(resolvePopupTag('div', ['section', 'p']), 'section', '第一个块级标签是 section');
});

test('列表里全是行内标签时回落到默认 div', () => {
	assert.equal(resolvePopupTag('span', ['span', 'em']), 'div', '全行内');
	assert.equal(resolvePopupTag('span', []), 'div', '空列表');
});

test('包裹标签合法时原样采纳', () => {
	assert.equal(resolvePopupTag('p', ['div', 'p']), 'p', 'p 合法');
	assert.equal(resolvePopupTag('div', ['div']), 'div', 'div 合法');
});

test('非字符串的包裹标签视为非法', () => {
	assert.equal(resolvePopupTag(undefined, ['div', 'p']), 'div', 'undefined');
	assert.equal(resolvePopupTag(42, ['p']), 'p', '数字');
});

test('归一化时包裹标签按同一套规则落定', () => {
	assert.equal(normalizeSettings({ supportedTags: 'span, div', popupTag: 'span' }).popupTag, 'div');
	assert.equal(
		normalizeSettings({ supportedTags: 'span', popupTag: 'span' }).popupTag,
		'div',
		'支持列表全是行内标签',
	);
});

// —— 支持标签列表 ——

test('支持标签串被规范化后再用于包裹标签回落', () => {
	const settings = normalizeSettings({ supportedTags: ' <DIV>，p、span span ', popupTag: 'p' });
	assert.deepEqual(settings.supportedTags, ['div', 'p', 'span'], '去符号、小写、去重');
	assert.equal(settings.popupTag, 'p', 'p 在列表里且是块级');
});

test('支持标签列表非法时回落默认标签', () => {
	assert.deepEqual(normalizeSettings({ supportedTags: 42 }).supportedTags, ['div', 'p'], '非字符串');
	assert.deepEqual(normalizeSettings({ supportedTags: ['!!!'] }).supportedTags, ['div', 'p'], '全非法项');
});
