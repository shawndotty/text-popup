/**
 * 多语言入口 —— 与 `ioto-update/src/lang/helpers.ts` 同构（目录、文件名、`t()` 签名一字不差），
 * 因此两个插件共用一套文案维护流程。与参照实现有三处**有意偏离**（详见 Plan-20260918-104304 第 2.5 节）：
 *
 * 1. 惰性读 locale：`t()` 每次调用才读 `moment.locale()`。本插件的设置页与弹窗是长生命周期、
 *    按需渲染的，惰性读取让「改语言后不必重载插件就已打开的设置页 / 弹窗也立刻用上新语言」。
 * 2. 语言代码归一化：`moment.locale()` 可能给出 `zh` / `zh-hans` / `zh-hant` / `zh-hk` / `en-gb`
 *    等变体，不归一化会让繁体用户静默退回英文。
 * 3. 英文文案用 sentence case：本插件 `AGENTS.md` 的 UX & copy guidelines 明确要求，
 *    且 `eslint-plugin-obsidianmd` 的 `ui/sentence-case` 在 recommended 集里启用。
 */

import { moment } from 'obsidian';
import en from './locale/en';
import zhCN from './locale/zh-cn';
import zhTW from './locale/zh-tw';

const localeMap: Record<string, Partial<typeof en>> = {
	en,
	'zh-cn': zhCN,
	'zh-tw': zhTW,
};

/**
 * 把 Obsidian 给出的语言代码归一化到 `localeMap` 的键。
 *
 * Obsidian 的语言代码形态不稳定：moment 侧是 `zh-tw`，Obsidian 语言文件侧是 `zh` / `zh-TW`，
 * 还有 `zh-hans` / `zh-hant` / `zh-hk` / `en-gb` 这类变体。先归一再查表，避免繁体用户静默退回英文。
 */
function normalizeLocale(raw: string): string {
	const locale = raw.toLowerCase().replace(/_/g, '-');
	if (locale.startsWith('zh')) {
		const traditional = ['hant', 'tw', 'hk', 'mo'].some((tag) => locale.includes(tag));
		return traditional ? 'zh-tw' : 'zh-cn';
	}
	return locale.split('-')[0] ?? 'en';
}

/** 取当前语言文案；语言不受支持或该语言缺此 key 时回退英文。 */
export function t(key: keyof typeof en): string {
	// `noUncheckedIndexedAccess` 让索引访问的结果带 `undefined`，因此必须用 `?.` 与 `??`。
	const dict = localeMap[normalizeLocale(moment.locale())];
	return dict?.[key] ?? en[key];
}
