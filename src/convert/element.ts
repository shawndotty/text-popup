/**
 * 外层元素定位：在区间原文里找到最外层的 `<T>…</T>`，供 Unpopup 只替换这一段。
 */

/** 区间里定位到的最外层元素。 */
export interface PopupElement {
	/** 外层标签名（小写）。 */
	tag: string;
	/** 标签内的原文。 */
	inner: string;
	/** 相对区间原文的偏移：`[start, end)` 覆盖 `<T>…</T>` 整段。 */
	start: number;
	end: number;
}

/** 区间开头的块级开标签（前导空格 ≤3，与 `blocks.ts` 的块起始判据一致）。 */
const OPENING_TAG = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?>/;

/**
 * 在区间原文里定位最外层元素，供 Unpopup 只替换 `<T>…</T>` 这一段。
 *
 * 闭标签取区间里**最后**一个 `</tag>`：HTML 块到第一个空行才结束（`blocks.ts`），
 * `</div>` 后面紧邻的非空行会被一起扫进区间，取最后一个才能把那些用户后文留在块外、不误删。
 * 只认「区间开头就是开标签、且标签在支持列表里」的形态；找不到闭标签则返回 null（畸形 HTML 不猜）。
 */
export function findOuterPopupElement(raw: string, tags: readonly string[]): PopupElement | null {
	const opening = OPENING_TAG.exec(raw);
	const tag = opening?.[1]?.toLowerCase();
	if (!opening || !tag || !tags.includes(tag)) return null;

	const closing = new RegExp(`</${tag}\\s*>`, 'gi');
	let last: RegExpExecArray | null = null;
	let match = closing.exec(raw);
	while (match) {
		last = match;
		match = closing.exec(raw);
	}

	const start = opening.index;
	if (!last || last.index <= start + opening[0].length) return null;

	return {
		tag,
		inner: raw.slice(start + opening[0].length, last.index),
		start,
		end: last.index + last[0].length,
	};
}
