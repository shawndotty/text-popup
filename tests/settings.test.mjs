/**
 * `settings.ts` 的行为用例 —— 磁盘数据 → 完整设置的归一化，以及声明式设置页的读 / 写 / 副作用。
 *
 * 这里守的是「老 `data.json` 不需要迁移脚本」这条承诺：任何字段缺失 / 类型不对 / 越界，
 * 都必须回落成一份能直接用的完整设置，而不是让插件带着 `undefined` 跑起来。
 *
 * 需要 obsidian 桩：`settings.ts` 是设置页所在模块，运行时会 `extends PluginSettingTab`，
 * 且**传递依赖** `scanner.ts` → `modal.ts`（因此桩必须覆盖那两处用到的符号，见 tests/stubs/）。
 *
 * 刻意没测：`TextPopupSettingTab` 的 DOM 渲染与交互（需要真实 DOM 与 Obsidian 设置页容器）。
 * 声明式设置页的「读 / 写 / 副作用」本轮做成了 `settings.ts` 里的纯函数，因此在这里直接钉住
 * （`getSettingDefinitions()` 本身不测 —— 它是这些纯函数的组装，跑真机验证）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	DEFAULT_BACKGROUND_HEX,
	DEFAULT_SETTINGS,
	DEFAULT_TEXT_HEX,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	normalizeSettings,
	readSettingValue,
	resolveMultiLineTag,
	resolveSingleLineTag,
	settingSideEffects,
	tagDropdownOptions,
	writeSettingValue,
} = await jiti.import('../src/settings.ts');

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
	assert.deepEqual(settings.blockKinds, {
		code: true,
		callout: true,
		math: false,
		image: true,
		quote: true,
		table: true,
		canvas: true,
	});
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

// —— 引用块开关（V114） ——

test('quote 开关默认开启，显式关闭时被保留', () => {
	assert.equal(DEFAULT_SETTINGS.blockKinds.quote, true, '默认开启');
	assert.equal(normalizeSettings({ blockKinds: { quote: false } }).blockKinds.quote, false, '关掉被保留');
});

test('老 data.json（没有 quote 键）升级后自动补 true，不需要迁移脚本', () => {
	// 落地前的 data.json 就属于这一种：只有 code / callout / math / image 四个键
	assert.equal(
		normalizeSettings({ blockKinds: { code: true, callout: true, math: true, image: true } }).blockKinds.quote,
		true,
	);
});

// —— 表格开关（V117） ——

test('table 开关默认开启，显式关闭时被保留', () => {
	assert.equal(DEFAULT_SETTINGS.blockKinds.table, true, '默认开启');
	assert.equal(normalizeSettings({ blockKinds: { table: false } }).blockKinds.table, false, '关掉被保留');
});

test('老 data.json（没有 table 键）升级后自动补 true，不需要迁移脚本', () => {
	// 落地前的 data.json 就属于这一种：只有 code / callout / math / image / quote 五个键
	assert.equal(
		normalizeSettings({
			blockKinds: { code: true, callout: true, math: true, image: true, quote: true },
		}).blockKinds.table,
		true,
	);
	assert.equal(normalizeSettings({ blockKinds: 42 }).blockKinds.table, true, '类型不对也补默认');
});

test('读 / 写：blockKinds.table 走嵌套路径，与其它键互不影响', () => {
	const settings = normalizeSettings(undefined);
	const blockKinds = settings.blockKinds;
	assert.equal(readSettingValue(settings, 'blockKinds.table'), true, '默认值');
	assert.equal(writeSettingValue(settings, 'blockKinds.table', false), true, '有改动');
	assert.equal(settings.blockKinds, blockKinds, '对象引用不变');
	assert.equal(blockKinds.table, false);
	assert.equal(blockKinds.quote, true, '其它键不受影响');
	assert.equal(readSettingValue(settings, 'blockKinds.table'), false, '读回来是关');
	assert.equal(writeSettingValue(settings, 'blockKinds.table', false), false, '同一个值再写一次不算改动');
});

test('副作用表：表格开关只刷新图标（与 code / callout / math / image 同类）', () => {
	assert.deepEqual([...settingSideEffects('blockKinds.table')], ['refreshActions']);
	assert.ok(!settingSideEffects('blockKinds.table').includes('quoteActions'), '表格不重建装饰集');
});

// —— Canvas 开关（V119） ——
//
// Canvas 独立成类之后单开一个开关（见 blocks.ts 的第 8 类）。它走的是与 table（V117）
// 完全相同的一套机械改动，「关 = 不挂图标、不进候选」—— 不是「退回核心的 minimap」。

test('canvas 开关默认开启，显式关闭时被保留', () => {
	assert.equal(DEFAULT_SETTINGS.blockKinds.canvas, true, '默认开启');
	assert.equal(normalizeSettings({ blockKinds: { canvas: false } }).blockKinds.canvas, false, '关掉被保留');
});

test('老 data.json（没有 canvas 键）升级后自动补 true，不需要迁移脚本', () => {
	// 落地前的 data.json 就属于这一种：只有 code / callout / math / image / quote / table 六个键
	assert.equal(
		normalizeSettings({
			blockKinds: { code: true, callout: true, math: true, image: true, quote: true, table: true },
		}).blockKinds.canvas,
		true,
	);
	assert.equal(normalizeSettings({ blockKinds: 42 }).blockKinds.canvas, true, '类型不对也补默认');
});

test('读 / 写：blockKinds.canvas 走嵌套路径，与其它键互不影响', () => {
	const settings = normalizeSettings(undefined);
	const blockKinds = settings.blockKinds;
	assert.equal(readSettingValue(settings, 'blockKinds.canvas'), true, '默认值');
	assert.equal(writeSettingValue(settings, 'blockKinds.canvas', false), true, '有改动');
	assert.equal(settings.blockKinds, blockKinds, '对象引用不变');
	assert.equal(blockKinds.canvas, false);
	assert.equal(blockKinds.image, true, '其它键不受影响');
	assert.equal(readSettingValue(settings, 'blockKinds.canvas'), false, '读回来是关');
	assert.equal(writeSettingValue(settings, 'blockKinds.canvas', false), false, '同一个值再写一次不算改动');
});

test('副作用表：Canvas 开关只刷新图标（与 code / callout / math / image / table 同类）', () => {
	assert.deepEqual([...settingSideEffects('blockKinds.canvas')], ['refreshActions']);
	assert.ok(!settingSideEffects('blockKinds.canvas').includes('quoteActions'), 'Canvas 不重建装饰集');
});

// —— Excalidraw 图片回退 ——

test('excalidrawImageFallback 默认关，老 data.json 升级后自动补 false', () => {
	assert.equal(DEFAULT_SETTINGS.excalidrawImageFallback, false, '默认关');
	assert.equal(normalizeSettings({}).excalidrawImageFallback, false, '空对象补 false');
	assert.equal(normalizeSettings({ excalidrawImageFallback: 1 }).excalidrawImageFallback, false, '非布尔的补 false');
	assert.equal(
		normalizeSettings({ excalidrawImageFallback: true }).excalidrawImageFallback,
		true,
		'显式开启被保留',
	);
});

test('excalidrawPreferredFormat 默认 svg，非 png 字段补 svg', () => {
	assert.equal(DEFAULT_SETTINGS.excalidrawPreferredFormat, 'svg', '默认 svg');
	assert.equal(normalizeSettings({}).excalidrawPreferredFormat, 'svg', '空对象补 svg');
	assert.equal(
		normalizeSettings({ excalidrawPreferredFormat: 'png' }).excalidrawPreferredFormat,
		'png',
		'png 被保留',
	);
	assert.equal(
		normalizeSettings({ excalidrawPreferredFormat: 'gif' }).excalidrawPreferredFormat,
		'svg',
		'非 svg/png 一律回落 svg',
	);
});

test('读 / 写：excalidrawImageFallback / excalidrawPreferredFormat 走 assign 路径', () => {
	const settings = normalizeSettings(undefined);
	assert.equal(readSettingValue(settings, 'excalidrawImageFallback'), false, '默认读回 false');
	assert.equal(readSettingValue(settings, 'excalidrawPreferredFormat'), 'svg', '默认读回 svg');
	assert.equal(writeSettingValue(settings, 'excalidrawImageFallback', true), true, '关 → 算改动');
	assert.equal(settings.excalidrawImageFallback, true);
	assert.equal(writeSettingValue(settings, 'excalidrawImageFallback', true), false, '同值不算改动');
	assert.equal(writeSettingValue(settings, 'excalidrawPreferredFormat', 'png'), true, 'svg → png 算改动');
	assert.equal(settings.excalidrawPreferredFormat, 'png');
	assert.equal(
		writeSettingValue(settings, 'excalidrawPreferredFormat', 'weird'),
		true,
		'非法字符串也算改动（归一化后是 svg）',
	);
	assert.equal(settings.excalidrawPreferredFormat, 'svg', '非法字符串归一化到 svg');
});

test('副作用表：两个 Excalidraw 设置项都不触发刷新（纯保存即可）', () => {
	assert.deepEqual([...settingSideEffects('excalidrawImageFallback')], [], 'fallback 开关');
	assert.deepEqual([...settingSideEffects('excalidrawPreferredFormat')], [], '格式选择');
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

// ——————————————————————————————————————————————————————————————
// 声明式设置页：读 / 写 / 副作用
// ——————————————————————————————————————————————————————————————

test('读：blockKinds 走嵌套路径，顶层键直接读', () => {
	const settings = normalizeSettings({ blockKinds: { quote: false } });
	assert.equal(readSettingValue(settings, 'blockKinds.quote'), false, '嵌套键');
	assert.equal(readSettingValue(settings, 'blockKinds.code'), true, '同层其它键');
	assert.equal(readSettingValue(settings, 'enabled'), true, '顶层键');
	assert.equal(readSettingValue(settings, 'renderRichText'), true, '顶层键');
});

test('读：支持的标签拼成逗号 + 空格的字符串（与改造前的 join 一致）', () => {
	assert.equal(readSettingValue(normalizeSettings(undefined), 'supportedTags'), 'div, p');
	assert.equal(
		readSettingValue(normalizeSettings({ supportedTags: 'div,p,section' }), 'supportedTags'),
		'div, p, section',
	);
});

test('读：「跟随主题」虚拟键由颜色是否为空串算出来', () => {
	assert.equal(readSettingValue(normalizeSettings(undefined), 'popupBackgroundFollowTheme'), true, '空串 = 跟随');
	assert.equal(
		readSettingValue(normalizeSettings({ popupBackgroundColor: '#123456' }), 'popupBackgroundFollowTheme'),
		false,
	);
	assert.equal(readSettingValue(normalizeSettings(undefined), 'popupTextFollowTheme'), true);
	assert.equal(
		readSettingValue(normalizeSettings({ popupTextColor: '#123456' }), 'popupTextFollowTheme'),
		false,
	);
});

test('读：跟随主题时色块控件拿到备用色（空串在 <input type=color> 上会显示成黑色）', () => {
	assert.equal(readSettingValue(normalizeSettings(undefined), 'popupBackgroundColor'), DEFAULT_BACKGROUND_HEX);
	assert.equal(readSettingValue(normalizeSettings(undefined), 'popupTextColor'), DEFAULT_TEXT_HEX);
	assert.equal(
		readSettingValue(normalizeSettings({ popupBackgroundColor: '#123456' }), 'popupBackgroundColor'),
		'#123456',
		'有值时原样返回',
	);
});

test('写：blockKinds 只动对应键，不重建整个对象，返回是否改动', () => {
	const settings = normalizeSettings(undefined);
	const blockKinds = settings.blockKinds;
	assert.equal(writeSettingValue(settings, 'blockKinds.quote', false), true, '有改动');
	assert.equal(settings.blockKinds, blockKinds, '对象引用不变');
	assert.equal(blockKinds.quote, false);
	assert.equal(blockKinds.code, true, '其它键不受影响');
	assert.equal(writeSettingValue(settings, 'blockKinds.quote', false), false, '同一个值再写一次不算改动');
});

test('写：「跟随主题」虚拟键两个方向都落到颜色字段上', () => {
	const settings = normalizeSettings({ popupBackgroundColor: '#123456' });
	assert.equal(writeSettingValue(settings, 'popupBackgroundFollowTheme', true), true);
	assert.equal(settings.popupBackgroundColor, '', '跟随主题 = 空串（与旧「跟随主题」按钮一致）');
	assert.equal(writeSettingValue(settings, 'popupBackgroundFollowTheme', false), true);
	assert.equal(settings.popupBackgroundColor, DEFAULT_BACKGROUND_HEX, '关掉开关给一个默认深色');
});

test('写：文字颜色的虚拟键同理，两个颜色互不影响', () => {
	const settings = normalizeSettings({ popupTextColor: '#abcdef' });
	assert.equal(writeSettingValue(settings, 'popupTextFollowTheme', true), true);
	assert.equal(settings.popupTextColor, '');
	assert.equal(settings.popupBackgroundColor, '', '背景色不受影响');
	assert.equal(readSettingValue(settings, 'popupTextColor'), DEFAULT_TEXT_HEX);
});

test('写：字号经 clampFontSize 落在 [12, 72]，非数字回落默认 16', () => {
	const settings = normalizeSettings(undefined);
	assert.equal(writeSettingValue(settings, 'popupFontSize', 999), true);
	assert.equal(settings.popupFontSize, FONT_SIZE_MAX, '过大');
	assert.equal(writeSettingValue(settings, 'popupFontSize', 5), true);
	assert.equal(settings.popupFontSize, FONT_SIZE_MIN, '过小');
	assert.equal(writeSettingValue(settings, 'popupFontSize', 20.6), true);
	assert.equal(settings.popupFontSize, 21, '四舍五入');
	assert.equal(writeSettingValue(settings, 'popupFontSize', 'x'), true);
	assert.equal(settings.popupFontSize, 16, '非数字回落默认');
});

test('写：支持标签脏输入先经 normalizeTagList 归一化', () => {
	const settings = normalizeSettings(undefined);
	assert.equal(writeSettingValue(settings, 'supportedTags', ' <DIV>，P、span span '), true);
	assert.deepEqual(settings.supportedTags, ['div', 'p', 'span'], '去符号、小写、去重');
});

test('写：归一化后没变化就返回 false（不保存、不刷新）', () => {
	const settings = normalizeSettings(undefined);
	assert.equal(writeSettingValue(settings, 'supportedTags', 'div, p '), false);
	assert.equal(writeSettingValue(settings, 'enabled', true), false);
	assert.equal(writeSettingValue(settings, 'popupFontSize', settings.popupFontSize), false);
});

test('写：支持标签改小时，两个包裹标签按回落链重新落定', () => {
	const settings = normalizeSettings({ supportedTags: 'div, p', multiLineTag: 'div', singleLineTag: 'p' });
	assert.equal(writeSettingValue(settings, 'supportedTags', 'section'), true);
	assert.deepEqual(settings.supportedTags, ['section']);
	assert.equal(settings.multiLineTag, 'section', 'div 被删 → 取列表里第一个块级标签');
	assert.equal(settings.singleLineTag, 'section', 'p 被删 → 回落到多行标签');
});

test('写：支持标签只是加项时，两个包裹标签原样保留', () => {
	const settings = normalizeSettings({ supportedTags: 'div, p', multiLineTag: 'div', singleLineTag: 'p' });
	assert.equal(writeSettingValue(settings, 'supportedTags', 'div, p, iframe'), true);
	assert.equal(settings.multiLineTag, 'div');
	assert.equal(settings.singleLineTag, 'p');
});

test('写：包裹标签经同一套判据回落（行内标签 / 不在列表里都不采纳）', () => {
	const settings = normalizeSettings({ multiLineTag: 'p' });
	assert.equal(writeSettingValue(settings, 'multiLineTag', 'span'), true);
	assert.equal(settings.multiLineTag, 'div', 'span 是行内标签 → 取列表里第一个块级标签');
	assert.equal(writeSettingValue(settings, 'singleLineTag', 'section'), false, 'section 不在列表 → 回落默认 p');
	assert.equal(settings.singleLineTag, 'p');
});

test('副作用表：只有开关与「支持的标签」会触发刷新', () => {
	assert.deepEqual([...settingSideEffects('enabled')], ['refreshActions', 'quoteActions']);
	assert.deepEqual([...settingSideEffects('blockKinds.code')], ['refreshActions'], '代码块不重建装饰集');
	assert.ok(settingSideEffects('blockKinds.quote').includes('quoteActions'), '引用块要额外发一次信号');
	assert.ok(!settingSideEffects('blockKinds.code').includes('quoteActions'));
	assert.deepEqual(
		[...settingSideEffects('supportedTags')],
		['refreshActions', 'rebuildDefinitions'],
		'标签改动要重建定义，两个下拉的选项才跟着变',
	);
	for (const kind of ['callout', 'math', 'image', 'canvas']) {
		assert.deepEqual([...settingSideEffects(`blockKinds.${kind}`)], ['refreshActions'], kind);
	}
});

test('副作用表：改字号 / 颜色 / 包裹标签 / 富文本开关都不刷新文档', () => {
	// 防「顺手多做一次全文档查询」—— README 的实现要点里记着这条路径的自激教训
	const silent = [
		'renderRichText',
		'popupFontSize',
		'popupBackgroundFollowTheme',
		'popupBackgroundColor',
		'popupTextFollowTheme',
		'popupTextColor',
		'singleLineTag',
		'multiLineTag',
	];
	for (const key of silent) {
		assert.deepEqual([...settingSideEffects(key)], [], key);
	}
});

test('包裹标签下拉的选项只取块级标签，行内标签被挡掉', () => {
	const settings = normalizeSettings({ supportedTags: 'div, p, span' });
	assert.deepEqual(Object.keys(tagDropdownOptions(settings, 'singleLineTag')), ['div', 'p']);
	assert.deepEqual(Object.keys(tagDropdownOptions(settings, 'multiLineTag')), ['div', 'p']);
});

test('包裹标签下拉永远包含当前值 —— 否则 <select> 会显示成空白', () => {
	// normalizeSettings 会把非法值拉回合法值，这里手工造出「当前值不在支持列表里」的形态
	const settings = normalizeSettings({ supportedTags: 'p, span' });
	settings.multiLineTag = 'section';
	assert.deepEqual(Object.keys(tagDropdownOptions(settings, 'multiLineTag')), ['p', 'section']);
});

// —— V127：关闭弹窗时定位到浏览的块（方案 [[Plan-20260926-180807]] §3.3 / §5.1） ——

test('locateOnClose：默认开（需求原文就是「我希望…可以直接定位到」）', () => {
	assert.equal(DEFAULT_SETTINGS.locateOnClose, true);
	assert.equal(normalizeSettings({}).locateOnClose, true, '空数据');
});

test('locateOnClose：老 data.json 无此键时自动补默认，不需要迁移脚本', () => {
	const settings = normalizeSettings({ enabled: false, popupFontSize: 20 });
	assert.equal(settings.locateOnClose, true, '缺键回落默认');
});

test('locateOnClose：显式 false 被保留，非布尔值回落默认', () => {
	assert.equal(normalizeSettings({ locateOnClose: false }).locateOnClose, false, '关掉的开关要留住');
	assert.equal(normalizeSettings({ locateOnClose: 'yes' }).locateOnClose, true, '字符串不采纳');
	assert.equal(normalizeSettings({ locateOnClose: 0 }).locateOnClose, true, '数字不采纳');
});

test('locateOnClose：读写往返一致，同值重复写返回 false（不触发保存）', () => {
	const settings = normalizeSettings({});
	assert.equal(readSettingValue(settings, 'locateOnClose'), true, '播种默认值');
	assert.equal(writeSettingValue(settings, 'locateOnClose', false), true, '改值返回 true');
	assert.equal(settings.locateOnClose, false);
	assert.equal(readSettingValue(settings, 'locateOnClose'), false, '读回改动后的值');
	assert.equal(writeSettingValue(settings, 'locateOnClose', false), false, '同值重复写返回 false');
	// 非布尔值一律落成 false（与 enabled / renderRichText 同一条 `value === true`）
	assert.equal(writeSettingValue(settings, 'locateOnClose', 'yes'), false, '当前已 false → 不改动');
	assert.equal(writeSettingValue(settings, 'locateOnClose', true), true, '改成 true');
	assert.equal(settings.locateOnClose, true);
});

test('locateOnClose：只保存，不刷新图标、不重建定义', () => {
	assert.deepEqual([...settingSideEffects('locateOnClose')], []);
});
