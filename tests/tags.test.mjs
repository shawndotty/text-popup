/**
 * `tags.ts` 的行为用例 —— 用户输入的标签串归一化，以及「容器内哪个元素算被标记的内容」。
 *
 * `findSupportedElement` 是「放大图标有没有被注入」的判据，两条规则都是易回归点：
 * 跳过核心的 `.embed-actions`（不跳会把按钮容器当内容）、先直接子元素再兜底一层嵌套。
 * 用**极简假元素**（只有 `tagName` / `classList.contains` / `children` / `querySelector`）验证，
 * 不引 jsdom：这两条规则是纯判定，不需要真实布局。
 *
 * 刻意没测：`scanner.ts` 里真实 DOM 上的查找路径（需要真实布局，交给真机验证）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { DEFAULT_TAGS, findSupportedElement, normalizeTagList } = await jiti.import('../src/tags.ts');

/** 极简假元素：只实现 findSupportedElement 真正用到的四个成员。 */
function fakeElement(tagName, { classes = [], children = [], nested = null } = {}) {
	return {
		tagName,
		classList: { contains: (cls) => classes.includes(cls) },
		children,
		querySelector: () => nested,
	};
}

// —— normalizeTagList ——

test('杂乱的标签串被去符号、小写、去重（中英文分隔符都认）', () => {
	assert.deepEqual(normalizeTagList(' <DIV>，p、span span '), ['div', 'p', 'span']);
	assert.deepEqual(normalizeTagList('div；p,section'), ['div', 'p', 'section']);
});

test('标签数组同样被归一化', () => {
	assert.deepEqual(normalizeTagList(['div', 'P', 'div']), ['div', 'p']);
});

test('非字符串、空串、全非法项都回落到默认标签', () => {
	for (const input of [undefined, null, 42, true, '', '!!!', ['!!!', 3], []]) {
		assert.deepEqual(normalizeTagList(input), [...DEFAULT_TAGS], `输入: ${JSON.stringify(input)}`);
	}
});

test('默认标签是 div 与 p', () => {
	assert.deepEqual([...DEFAULT_TAGS], ['div', 'p']);
});

// —— findSupportedElement ——

test('标签列表为空时返回 null', () => {
	assert.equal(findSupportedElement(fakeElement('DIV'), []), null);
});

test('命中直接子元素时返回它（取第一个匹配的）', () => {
	const span = fakeElement('SPAN');
	const div = fakeElement('DIV');
	const block = fakeElement('DIV', { children: [span, div] });
	assert.equal(findSupportedElement(block, ['div']), div, '跳过不匹配的 span');
});

test('跳过核心的 .embed-actions 容器', () => {
	const actions = fakeElement('DIV', { classes: ['embed-actions'] });
	const paragraph = fakeElement('P');
	const block = fakeElement('DIV', { children: [actions, paragraph] });
	assert.equal(findSupportedElement(block, ['div', 'p']), paragraph, 'embed-actions 不被当内容');
});

test('直接子元素都没命中时兜底查一层嵌套', () => {
	const paragraph = fakeElement('P');
	const block = fakeElement('DIV', {
		children: [fakeElement('PRE')],
		nested: paragraph,
	});
	assert.equal(findSupportedElement(block, ['div', 'p']), paragraph);
});

test('兜底也找不到时返回 null', () => {
	const block = fakeElement('DIV', { children: [fakeElement('PRE')], nested: null });
	assert.equal(findSupportedElement(block, ['div', 'p']), null);
});

test('只有 .embed-actions 一个子元素时也走兜底路径', () => {
	const actions = fakeElement('DIV', { classes: ['embed-actions'] });
	const paragraph = fakeElement('P');
	const block = fakeElement('DIV', { children: [actions], nested: paragraph });
	assert.equal(findSupportedElement(block, ['div']), paragraph);
});
