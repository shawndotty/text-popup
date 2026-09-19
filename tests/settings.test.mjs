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
const { DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN, normalizeSettings, resolveMultiLineTag, resolveSingleLineTag } =
	await jiti.import('../src/settings.ts');

// —— 默认值与老数据 ——

test('空数据归一化为完整默认设置', () => {
	assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS, 'undefined');
	assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS, 'null');
	assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS, '空对象');
});

test('老 data.json 缺 blockKinds / 包裹标签时逐项补齐', () => {
	const settings = normalizeSettings({ enabled: false, popupFontSize: 20 });
	assert.deepEqual(settings.blockKinds, DEFAULT_SETTINGS.blockKinds, 'blockKinds 补齐');
	assert.equal(settings.multiLineTag, 'div', 'multiLineTag 补齐');
	assert.equal(settings.singleLineTag, 'p', 'singleLineTag 补齐新默认');
	assert.deepEqual(settings.supportedTags, ['div', 'p'], 'supportedTags 补齐');
	assert.equal(settings.enabled, false, '已有字段保留');
	assert.equal(settings.popupFontSize, 20, '已有字段保留');
});

test('blockKinds 缺键时逐键回落，已有的键保留', () => {
	const settings = normalizeSettings({ blockKinds: { math: false } });
	assert.deepEqual(settings.blockKinds, { code: true, callout: true, math: false, image: true });
});

// —— 图片开关（V112） ——

test('image 开关默认开启，且显式关闭时被保留', () => {
	assert.equal(DEFAULT_SETTINGS.blockKinds.image, true, '默认开启');
	assert.equal(normalizeSettings({ blockKinds: { image: false } }).blockKinds.image, false, '关掉被保留');
});

test('老 data.json（没有 image 键）升级后自动补 true，不需要迁移脚本', () => {
	assert.equal(normalizeSettings({ blockKinds: { code: true, callout: true, math: true } }).blockKinds.image, true);
	assert.equal(normalizeSettings({ blockKinds: 42 }).blockKinds.image, true, '类型不对也补默认');
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

// —— 多行包裹标签（原「包裹标签」）的约束式回落 ——

test('行内标签不能当多行包裹标签，回落到列表里第一个块级标签', () => {
	assert.equal(resolveMultiLineTag('span', ['div', 'span']), 'div', 'span 被挤掉');
});

test('多行包裹标签不在支持列表里时，取列表里第一个块级标签', () => {
	assert.equal(resolveMultiLineTag('section', ['div', 'p']), 'div', '不在列表');
	assert.equal(resolveMultiLineTag('div', ['section', 'p']), 'section', '第一个块级标签是 section');
});

test('列表里全是行内标签时回落到默认 div', () => {
	assert.equal(resolveMultiLineTag('span', ['span', 'em']), 'div', '全行内');
	assert.equal(resolveMultiLineTag('span', []), 'div', '空列表');
});

test('多行包裹标签合法时原样采纳', () => {
	assert.equal(resolveMultiLineTag('p', ['div', 'p']), 'p', 'p 合法');
	assert.equal(resolveMultiLineTag('div', ['div']), 'div', 'div 合法');
});

test('非字符串的多行包裹标签视为非法', () => {
	assert.equal(resolveMultiLineTag(undefined, ['div', 'p']), 'div', 'undefined');
	assert.equal(resolveMultiLineTag(42, ['p']), 'p', '数字');
});

test('归一化时多行包裹标签按同一套规则落定', () => {
	assert.equal(normalizeSettings({ supportedTags: 'span, div', popupTag: 'span' }).multiLineTag, 'div');
	assert.equal(
		normalizeSettings({ supportedTags: 'span', popupTag: 'span' }).multiLineTag,
		'div',
		'支持列表全是行内标签',
	);
});

// —— 老键 popupTag 的读取回落（K3） ——

test('只有老键 popupTag 时读成多行标签，单行取新默认 p', () => {
	const settings = normalizeSettings({ popupTag: 'p' });
	assert.equal(settings.multiLineTag, 'p', '旧键读入多行');
	assert.equal(settings.singleLineTag, 'p', '单行取新默认 p');
});

test('老键值非法时走同一套判据（块级 + 在支持列表里）', () => {
	assert.equal(normalizeSettings({ popupTag: 'span', supportedTags: 'div,p' }).multiLineTag, 'div');
	assert.equal(normalizeSettings({ popupTag: 42 }).multiLineTag, 'div', '类型不对');
});

test('新键优先于老键', () => {
	const settings = normalizeSettings({ multiLineTag: 'p', popupTag: 'section' });
	assert.equal(settings.multiLineTag, 'p', '新键胜出');
});

// —— 单行包裹标签的回落链 ——

test('没有 singleLineTag 时取默认 p', () => {
	assert.equal(normalizeSettings({}).singleLineTag, 'p', '空数据');
	assert.equal(normalizeSettings({ multiLineTag: 'section' }).singleLineTag, 'p', '默认 p 先于多行标签');
});

test('p 不在支持列表里时，单行回落到多行标签（等价于旧行为）', () => {
	assert.equal(normalizeSettings({ supportedTags: 'div', popupTag: 'div' }).singleLineTag, 'div');
	assert.equal(
		normalizeSettings({ supportedTags: 'section', multiLineTag: 'section' }).singleLineTag,
		'section',
	);
	assert.equal(
		normalizeSettings({ supportedTags: 'div, section', multiLineTag: 'section' }).singleLineTag,
		'section',
		'优先回落到多行标签，而不是列表里第一个块级标签',
	);
});

test('singleLineTag 合法时原样采纳', () => {
	const settings = normalizeSettings({ supportedTags: 'div,p,section', singleLineTag: 'section' });
	assert.equal(settings.singleLineTag, 'section', '列表含 section');
});

test('singleLineTag 非法时先试 p，p 也不可用再取多行标签', () => {
	assert.equal(normalizeSettings({ singleLineTag: 'span' }).singleLineTag, 'p', 'span 非法 → p');
	assert.equal(normalizeSettings({ singleLineTag: 42 }).singleLineTag, 'p', '类型不对 → p');
	assert.equal(
		normalizeSettings({ supportedTags: 'div', singleLineTag: 'span' }).singleLineTag,
		'div',
		'p 不可用 → 多行标签',
	);
});

test('单行与多行都不可用时回落到默认 div', () => {
	assert.equal(resolveSingleLineTag('span', 'div', ['span', 'em']), 'div', '支持列表全是行内标签');
	assert.equal(resolveSingleLineTag(undefined, 'div', []), 'div', '空列表');
});

test('两个标签允许设成同一个值（关掉新特性的合法手段，D4）', () => {
	const settings = normalizeSettings({ singleLineTag: 'div', multiLineTag: 'div' });
	assert.equal(settings.singleLineTag, 'div');
	assert.equal(settings.multiLineTag, 'div');
});

test('单行回落链把多行标签当作其中一环', () => {
	assert.equal(resolveSingleLineTag('p', 'section', ['div', 'p']), 'p', '直接传 p 也认');
	assert.equal(resolveSingleLineTag(undefined, 'section', ['div', 'section']), 'section', '取到多行标签');
	assert.equal(resolveSingleLineTag(undefined, 'div', ['div']), 'div', 'p 不在列表 → 多行标签');
});

// —— 支持标签列表 ——

test('支持标签串被规范化后再用于包裹标签回落', () => {
	const settings = normalizeSettings({ supportedTags: ' <DIV>，p、span span ', popupTag: 'p' });
	assert.deepEqual(settings.supportedTags, ['div', 'p', 'span'], '去符号、小写、去重');
	assert.equal(settings.multiLineTag, 'p', 'p 在列表里且是块级');
	assert.equal(settings.singleLineTag, 'p', '单行同样是 p');
});

test('支持标签列表非法时回落默认标签', () => {
	assert.deepEqual(normalizeSettings({ supportedTags: 42 }).supportedTags, ['div', 'p'], '非字符串');
	assert.deepEqual(normalizeSettings({ supportedTags: ['!!!'] }).supportedTags, ['div', 'p'], '全非法项');
});
