/**
 * 标签注册表 —— 唯一需要改动的扩展点。
 *
 * 扫描锚点始终是「块级原始 HTML」容器（见 scanner.ts 的 BLOCK_SELECTOR），
 * 这里只负责决定「容器内哪个元素算被标记的内容」。
 */

/** 默认支持的标签，也是设置项被清空时的回退值。 */
export const DEFAULT_TAGS: readonly string[] = ['div', 'p'];

/** 合法标签名：字母开头，只含字母、数字、连字符（保证拼接成选择器时安全）。 */
const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * 把用户输入的标签串（"div, p" / "div p"）或标签数组，整理成规范化的标签列表。
 * 会去掉 `<>` `/` 等符号、转小写、去重、丢弃非法项；结果为空时回退到默认标签。
 */
export function normalizeTagList(input: unknown): string[] {
	const raw = Array.isArray(input)
		? input.filter((item): item is string => typeof item === 'string').join(',')
		: typeof input === 'string'
			? input
			: '';

	const tags: string[] = [];
	for (const piece of raw.split(/[\s,，、;；]+/)) {
		const tag = piece.replace(/[<>/]/g, '').toLowerCase();
		if (!tag || !TAG_PATTERN.test(tag) || tags.includes(tag)) continue;
		tags.push(tag);
	}

	return tags.length > 0 ? tags : [...DEFAULT_TAGS];
}

/**
 * 在块级 HTML 容器里找出被标记的元素。
 * 先看直接子元素（跳过核心的 .embed-actions 按钮容器），再兜底查一层嵌套（如 `<div><p>…</p></div>`）。
 */
export function findSupportedElement(
	blockEl: HTMLElement,
	tags: readonly string[],
): HTMLElement | null {
	if (tags.length === 0) return null;

	for (const child of Array.from(blockEl.children)) {
		if (child.classList.contains('embed-actions')) continue;
		if (tags.includes(child.tagName.toLowerCase())) return child as HTMLElement;
	}

	return blockEl.querySelector<HTMLElement>(tags.join(','));
}
