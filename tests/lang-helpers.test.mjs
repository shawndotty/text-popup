/**
 * `lang/helpers.ts` 的行为用例 —— `t()` 的语言选择与回退。
 *
 * V106 刚上的多语言，所以这里刻意**不硬编码任何语言的文案**（除英文基准外）：
 * 断言的是「切到 A 语言拿到 A 文案、切到 B 拿到 B 文案、两者不同」「不支持的语言回退英文」
 * 这类关系，硬编码会让用例在词典调整时假绿。
 *
 * 关于语言代码的可达性（已实跑 + 对照 `obsidian.asar` 核实）：
 * Obsidian 先把语言代码归一化再调用 `window.moment.locale()`
 * （`obsidian.asar` 里的 `sd = {zh:"zh-cn", cz:"cs", no:"nb"}` + `window.moment.locale(gd)`），
 * 且 moment 只带 `zh-cn` / `zh-hk` / `zh-mo` / `zh-tw` 四个中文包。因此：
 * - 实机 `moment.locale()` 只可能是 `zh-cn`（界面选「简体中文」）或 `zh-tw`（选「繁體中文」）。
 * - `helpers.ts` 里针对 `zh-hant` / `zh-hans` / 裸 `zh` 的分支是**防御性**的：
 *   `moment.locale('zh-hant')` 在 moment 侧是 no-op（保持上一个语言），因此这些分支
 *   无法通过 `t()` 观测。用例只覆盖实际可达的代码，避免把不可达路径写成假绿。
 *
 * 需要 obsidian 桩：`helpers.ts` 从 `obsidian` 取 `moment`；桩重导出的是**真实** moment，
 * 这样语言切换与 `zh-*` 变体才是真的被验到。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const { moment } = await jiti.import('obsidian');
const { t } = await jiti.import('../src/lang/helpers.ts');

/** 在指定语言下取文案；用完复位，避免用例之间互相影响。 */
function tIn(locale, key = 'Popup selected text') {
	moment.locale(locale);
	const value = t(key);
	moment.locale('en');
	return value;
}

test('简繁两种中文拿到不同文案，且都不是英文', () => {
	const en = tIn('en', 'Popup selected text');
	const simplified = tIn('zh-cn', 'Popup selected text');
	const traditional = tIn('zh-tw', 'Popup selected text');

	assert.notEqual(simplified, en, '简体不应等于英文');
	assert.notEqual(traditional, en, '繁体不应等于英文');
	assert.notEqual(traditional, simplified, '繁体不应等于简体');
});

test('Obsidian 实际使用的语言代码形态（zh-TW）走繁体', () => {
	assert.equal(tIn('zh-TW'), tIn('zh-tw'), 'zh-TW 与 zh-tw 同文案');
	assert.notEqual(tIn('zh-TW'), tIn('zh-cn'), 'zh-TW 不应落到简体');
});

test('zh-hk / zh-mo 归一到繁体，zh_cn 归一到简体', () => {
	assert.equal(tIn('zh-hk'), tIn('zh-tw'), 'zh-hk');
	assert.equal(tIn('zh-mo'), tIn('zh-tw'), 'zh-mo');
	assert.equal(tIn('zh_cn'), tIn('zh-cn'), 'zh_cn（下划线形态）');
});

test('带地区的英文变体（en-gb）保持在英文', () => {
	assert.equal(tIn('en-gb'), tIn('en'), 'en-gb');
});

test('不支持的语言回退英文', () => {
	assert.equal(tIn('ja'), tIn('en'), 'ja');
	assert.equal(tIn('fr'), tIn('en'), 'fr');
});

test('英文词典的键与值相同（sentence case 约定）', async () => {
	const en = (await jiti.import('../src/lang/locale/en.ts')).default;
	for (const [key, value] of Object.entries(en)) {
		assert.equal(value, key, `英文词典的键与值应一致: ${key}`);
	}
});

test('已知键在每种语言下都返回非空字符串', () => {
	for (const locale of ['en', 'zh-cn', 'zh-tw']) {
		for (const key of ['Popup selected text', 'Unpopup selected text']) {
			const value = tIn(locale, key);
			assert.equal(typeof value, 'string', `${locale} / ${key} 应为字符串`);
			assert.notEqual(value.trim(), '', `${locale} / ${key} 不应为空`);
		}
	}
});
