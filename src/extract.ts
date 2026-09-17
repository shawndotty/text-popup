/**
 * 从被标记的元素里取出用于放大的纯文本。
 *
 * - 优先 innerText：保留 `<br>` 与块级元素造成的换行，符合「原样放大」的语义。
 * - 回退 textContent：元素处于隐藏 / 未布局状态时 innerText 可能为空。
 * - 折叠 3 个以上连续换行：抵消 HTML 源码缩进带来的空行堆积。
 */
export function extractText(el: HTMLElement): string {
	const raw = (el.innerText ?? '').trim() || (el.textContent ?? '').trim();
	return raw.replace(/\n{3,}/g, '\n\n');
}
