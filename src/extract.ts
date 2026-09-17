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

/** 核心在块内可能注入的非内容节点，不剔除会在弹窗里留下零宽占位与重复按钮。 */
const INJECTED_SELECTOR = '.cm-widgetBuffer, .edit-block-button, .copy-code-button';

/**
 * 富文本渲染的输入：块级 HTML 块的内容（去掉外层容器标签）+ 去缩进。
 *
 * 为什么去掉外层标签：直接把 outerHTML 交给 Markdown 渲染器时，字符串以 `<div>` 开头，
 * 会被按 CommonMark 的 HTML block 规则整段吞掉，块内的 `**粗体**` 依然不解析。去掉后
 * 字符串以普通文本或行内标签开头，内嵌的 `<span>` / `<table>` / `<img>` 照常透传。
 *
 * 为什么必须去缩进：块在源码里通常整体缩进，innerHTML 会把缩进原样带出；
 * Markdown 中 4 个及以上前导空格 = 代码块，不去缩进会把正常文字渲染成代码块。
 */
export function extractRichSource(el: HTMLElement): string {
	const clone = el.cloneNode(true) as HTMLElement;
	clone.querySelectorAll(INJECTED_SELECTOR).forEach((node) => node.remove());
	clone.removeAttribute('contenteditable');
	clone.removeAttribute('spellcheck');
	return dedent(clone.innerHTML);
}

/** 去首尾空行 + 按最小缩进整体左移（只左移，不吞内容）。 */
function dedent(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	while (lines.length > 0 && !(lines[0] ?? '').trim()) lines.shift();
	while (lines.length > 0 && !(lines[lines.length - 1] ?? '').trim()) lines.pop();
	const indents = lines
		.filter((line) => line.trim())
		.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
	const min = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((line) => line.slice(min)).join('\n');
}
