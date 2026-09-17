/**
 * 按笔记文本找出「块级原始 HTML」区间 —— 候选集的事实来源。
 *
 * 为什么不用 DOM：Live Preview 只把视口附近的行渲染成 DOM，滚出视口的块连按钮都没有，
 * 于是「能翻到几条」会随滚动变化。数量必须是笔记的属性，不能是屏幕的属性。
 */

/**
 * markdown-it 的 HTML block 标签表：行首命中这些标签时按 CommonMark 类型 6 起块。
 * 原样取自本机 `obsidian.asar` 里的模块（勿手改）。
 */
const CORE_HTML_TAGS =
	'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hgroup|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|pre|section|source|summary|title|table|tbody|td|tfoot|th|thead|tr|track|ul';

const BLOCK_TAGS = new Set(CORE_HTML_TAGS.split('|'));

/**
 * 核心的 `Lm(tag)` 判定为「行内」的标签（同样原样取自本机 `obsidian.asar`）。
 *
 * 核心建 widget 时用 `block = !Lm(tag)` 决定容器是 `div`（块，带 `.cm-embed-block` 与图标）
 * 还是 `span`（行内，不带图标）。命中这张表的标签永远不会有放大图标，因此不算候选。
 * 目前它与上面的块标签表只有 `iframe` 相交，保留整张表是为了不在本地做裁剪、避免日后漂移。
 */
const INLINE_TAGS = new Set(
	'a|abbr|acronym|b|bdi|bdo|big|br|button|canvas|cite|code|data|del|dfn|em|embed|i|iframe|img|input|ins|kbd|label|map|mark|meter|noscript|object|output|picture|progress|q|ruby|s|samp|select|small|span|strong|sub|sup|svg|textarea|time|u|tt|var|video|wbr'.split(
		'|',
	),
);

/** 核心对这几类标签不建 widget（`obsidian.asar` 里的排除表），扫描同样跳过。 */
const SKIPPED_TAGS = new Set(['script', 'style', 'link', 'meta', 'object', 'embed', 'webview']);

/** 一个块级 HTML 区间；行号 0 起，与 Editor 的行号一致。 */
export interface HtmlBlockRegion {
	startLine: number;
	endLine: number;
	/** 该区间的原始文本（可能含 Markdown，与核心 widget 的输入一致）。 */
	raw: string;
}

/** 行首（≤3 个前导空格）是否为块级 HTML 起始标签；是则返回小写标签名。 */
function matchBlockTag(line: string): string | null {
	// CommonMark 类型 6：标签后必须是空白 / `/` / `>` / 行尾；4 空格缩进属于代码块，不算。
	const match = /^ {0,3}<([a-z][a-z0-9-]*)(?=[\s/>]|$)/i.exec(line);
	const tag = match?.[1]?.toLowerCase();
	return tag && BLOCK_TAGS.has(tag) ? tag : null;
}

/** 扫描全文的块级 HTML 区间，按文档顺序。 */
export function scanHtmlBlocks(text: string): HtmlBlockRegion[] {
	const lines = text.split('\n');
	const regions: HtmlBlockRegion[] = [];

	for (let start = 0; start < lines.length; start++) {
		const tag = matchBlockTag(lines[start] ?? '');
		if (!tag) continue;

		// 类型 6 的 HTML 块到第一个空行结束（文末也算结束）
		let end = start;
		while (end + 1 < lines.length && (lines[end + 1] ?? '').trim() !== '') end++;

		if (!SKIPPED_TAGS.has(tag) && !INLINE_TAGS.has(tag)) {
			regions.push({ startLine: start, endLine: end, raw: lines.slice(start, end + 1).join('\n') });
		}
		start = end;
	}
	return regions;
}
