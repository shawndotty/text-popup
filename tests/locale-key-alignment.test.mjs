/**
 * 词典 key 对齐用例 —— 防止「英文加了 key、翻译漏了」或「翻译里写了英文没有的 key」。
 *
 * 与参照插件（`ioto-tasks-center/tests/locale-key-alignment.test.mjs`）的**有意偏离**：
 * 参照实现断言「各语言的 key 完全相同」（双向），而本插件的 `en.ts` 头注释明确
 * 「非英文词典是 `Partial<typeof en>`，可以增量补」。因此这里**只查 extra，允许 missing**：
 * 新增 key 但翻译还没跟上不该让 CI 变红（那与插件自身约定冲突），但拼错的 key、多余的 key、
 * 空值仍然是真错误，必须拦住。
 *
 * `helpers.ts` 的 `localeMap` 只登记了 en / zh-cn / zh-tw，所以这里也断言这三个词典都在。
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });

const LOCALE_DIR = fileURLToPath(new URL('../src/lang/locale/', import.meta.url));

/** 发现所有语言词典文件（排除 `index`，按文件名排序）。 */
function discoverLocaleNames() {
	return readdirSync(LOCALE_DIR)
		.filter((name) => name.endsWith('.ts'))
		.map((name) => name.replace(/\.ts$/, ''))
		.filter((name) => name !== 'index')
		.sort();
}

async function loadDictionary(name) {
	const mod = await jiti.import(path.join(LOCALE_DIR, `${name}.ts`));
	return mod.default ?? mod;
}

const names = discoverLocaleNames();

test('至少发现两个语言词典，且包含 helpers 登记的三个', () => {
	assert.ok(names.length >= 2, `语言词典过少: ${names.join(', ')}`);
	for (const expected of ['en', 'zh-cn', 'zh-tw']) {
		assert.ok(names.includes(expected), `缺少语言词典: ${expected}`);
	}
});

test('英文基准词典没有空值或非字符串值', async () => {
	const en = await loadDictionary('en');
	const entries = Object.entries(en);
	assert.ok(entries.length > 0, '英文词典不应为空');
	for (const [key, value] of entries) {
		assert.equal(typeof value, 'string', `en: ${key} 应为字符串`);
		assert.notEqual(value.trim(), '', `en: ${key} 不应为空`);
	}
});

test('非英文词典没有英文里不存在的 key，也没有空值或非字符串值', async () => {
	const en = await loadDictionary('en');
	const enKeys = new Set(Object.keys(en));

	for (const name of names) {
		if (name === 'en') continue;
		const dict = await loadDictionary(name);
		const extra = Object.keys(dict).filter((key) => !enKeys.has(key));
		assert.deepEqual(extra, [], `${name} 存在英文词典里没有的 key`);

		for (const [key, value] of Object.entries(dict)) {
			assert.equal(typeof value, 'string', `${name}: ${key} 应为字符串`);
			assert.notEqual(value.trim(), '', `${name}: ${key} 不应为空`);
		}
	}
});
