/**
 * 按笔记文本找出「可放大的区块」区间 —— 候选集的事实来源。
 *
 * 前四类区块（块级原始 HTML / 围栏代码块 / Callout / `$$` 数学块）在 Live Preview 里
 * 都是核心的 CM6 widget：容器都带 `.cm-embed-block`，都在容器内建 `.embed-actions`
 * 放控制图标。所以候选集可以共用一套扫描器，只在类别上分流。
 *
 * 第 5 类 `image` 是唯一**不**走 `.cm-embed-block` 的：核心给图片 widget 自己建的容器是
 * `div.image-embed`（`addActions` 由编辑器 widget 的 `initDOM` 调用，在容器内建同一套
 * `.embed-actions`）。所以它照样有原生「放大」图标、照样算一条候选，只是注入锚点不同
 * （见 scanner.ts 的 `IMAGE_SELECTOR`）。
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

/** 可放大的区块类别。`html` = 用户手写的块级原始 HTML，其余四类是 Obsidian 原生区块。 */
export type BlockKind = 'html' | 'code' | 'callout' | 'math' | 'image';

/** 一个可放大区间；行号 0 起，与 Editor 的行号一致。 */
export interface TextBlockRegion {
	kind: BlockKind;
	startLine: number;
	endLine: number;
	/**
	 * 该区间的原始文本，与核心 widget 的输入一致：前四类含围栏 / `> ` 前缀 / `$$`；
	 * `image` 类是**命中的那段图片语法**（不是整行 —— 引用行 / 列表行的 `> ` / `- ` 前缀
	 * 喂给 MarkdownRenderer 会多渲染出一层引用块 / 列表项）。
	 */
	raw: string;
}

/** 一次命中：区间范围，以及它是否算候选（HTML 命中排除表时只吃区间、不产候选）。 */
interface BlockMatch {
	kind: BlockKind;
	endLine: number;
	include: boolean;
	/** 覆盖区间原文时用（目前只有 `image` 类：存命中的语法片段而不是整行）。 */
	raw?: string;
}

/**
 * 该标签能否生成一个带放大图标的块。
 *
 * 两个条件都与核心对齐：在块级标签表里（否则按行内处理、不进候选），且不在核心的行内表里
 * （`iframe` 同时出现在两张表中，核心给它建的是 `span` 容器，因此也不算）。
 * 命令层的「包裹标签」必须过这一关，否则块生成了也不会有放大图标。
 */
export function isBlockLevelTag(tag: string): boolean {
	const name = tag.trim().toLowerCase();
	return BLOCK_TAGS.has(name) && !INLINE_TAGS.has(name);
}

/** 行首（≤3 个前导空格）是否为块级 HTML 起始标签；是则返回小写标签名。 */
function matchBlockTag(line: string): string | null {
	// CommonMark 类型 6：标签后必须是空白 / `/` / `>` / 行尾；4 空格缩进属于代码块，不算。
	const match = /^ {0,3}<([a-z][a-z0-9-]*)(?=[\s/>]|$)/i.exec(line);
	const tag = match?.[1]?.toLowerCase();
	return tag && BLOCK_TAGS.has(tag) ? tag : null;
}

/** 块级原始 HTML：到第一个空行结束（文末也算结束）。 */
function matchHtmlBlock(lines: readonly string[], start: number): BlockMatch | null {
	const tag = matchBlockTag(lines[start] ?? '');
	if (!tag) return null;

	let end = start;
	while (end + 1 < lines.length && (lines[end + 1] ?? '').trim() !== '') end++;

	// 排除表里的标签不产候选，但仍要吃掉整段：块内的行不该被当成新的起始行。
	return {
		kind: 'html',
		endLine: end,
		include: !SKIPPED_TAGS.has(tag) && !INLINE_TAGS.has(tag),
	};
}

/** 开围栏：3 个及以上的反引号或波浪号；反引号围栏的信息串里不允许再出现反引号。 */
const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 闭围栏：同字符、长度不小于开围栏，且不带信息串。 */
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** 围栏代码块：到闭围栏为止；找不到闭围栏（未闭合）则吃到文末。 */
function matchFencedBlock(lines: readonly string[], start: number): BlockMatch | null {
	const fence = FENCE_START.exec(lines[start] ?? '')?.[1];
	if (!fence) return null;

	const char = fence[0];
	const length = fence.length;
	let end = lines.length - 1;
	for (let i = start + 1; i < lines.length; i++) {
		const closing = FENCE_END.exec(lines[i] ?? '')?.[1];
		if (closing && closing[0] === char && closing.length >= length) {
			end = i;
			break;
		}
	}
	return { kind: 'code', endLine: end, include: true };
}

/** Callout 起始行：`> [!TYPE]`，可选折叠标记 `+` / `-`。 */
const CALLOUT_START = /^ {0,3}> ?\[![^\]]+\][+-]?/;
/** 引用行：Callout 的正文每行都带 `> ` 前缀。 */
const QUOTE_LINE = /^ {0,3}>/;

/** Callout：到第一个不以 `>` 开头的行为止。 */
function matchCallout(lines: readonly string[], start: number): BlockMatch | null {
	if (!CALLOUT_START.test(lines[start] ?? '')) return null;

	let end = start;
	while (end + 1 < lines.length && QUOTE_LINE.test(lines[end + 1] ?? '')) end++;
	return { kind: 'callout', endLine: end, include: true };
}

/** 数学块起始行：行首 `$$`。行内公式 `$x$` 不带 `$$`，不会命中。 */
const MATH_START = /^ {0,3}\$\$/;

/**
 * `$$` 数学块。
 * `$$ a+b = c$$` 是合法的块级写法：同一行里出现第二个 `$$` 就当场结束，不能要求 `$$` 独占一行。
 */
function matchMathBlock(lines: readonly string[], start: number): BlockMatch | null {
	if (!MATH_START.test(lines[start] ?? '')) return null;

	const first = (lines[start] ?? '').indexOf('$$');
	if ((lines[start] ?? '').indexOf('$$', first + 2) >= 0) {
		return { kind: 'math', endLine: start, include: true };
	}

	let end = lines.length - 1;
	for (let i = start + 1; i < lines.length; i++) {
		if ((lines[i] ?? '').includes('$$')) {
			end = i;
			break;
		}
	}
	return { kind: 'math', endLine: end, include: true };
}

/** Live Preview 里会被核心建成「图片嵌入」的扩展名（原样取自 `obsidian.asar` 的 `app.js`，勿手改）。 */
const IMAGE_EXTENSIONS = new Set(['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif']);

/** `![[…]]` / `![[…|100]]`（不含换行）。导出给 extract.ts 复用，避免两处各写一份。 */
export const WIKI_EMBED = /!\[\[([^\]\n]+)\]\]/;

/** `![alt](target)` / `![alt|120](target "title")`；第一个捕获组是圆括号里的**全部参数**。 */
export const MD_IMAGE = /!\[[^\]\n]*\]\(([^)\n]+)\)/;

/** 行内 HTML 标签：命中时这张图在行内 HTML widget 里（没有 `.embed-actions`），不做候选。 */
const HTML_TAG = /<\/?[a-zA-Z][^>\n]*>/;

/** wiki 形态：target 的扩展名必须在图片表里（`![[某笔记]]` / `![[x.pdf]]` 都不是图片嵌入）。 */
function wikiImageTarget(inner: string): string | null {
	const target = (inner.split('|')[0] ?? '').split('#')[0]?.trim() ?? '';
	return hasImageExtension(target) ? target : null;
}

/**
 * `![…](…)` 圆括号内容的「路径形态」解析：
 * 先取出 target（`<…>` 形态允许含空格；其余形态在第一个空白处截断，空格在 URL 里必须转义），
 * 再去掉 `#` / `?` 之后的参数，最后按扩展名 / 外链判据决定算不算图片。
 */
function pathImageTarget(inner: string): string | null {
	const trimmed = inner.trim();
	const angle = /^<([^>]*)>/.exec(trimmed);
	const target = angle ? (angle[1] ?? '') : (/^\S+/.exec(trimmed)?.[0] ?? '');
	const clean = target.split(/[#?]/)[0]?.trim() ?? '';
	// 外链（含 `://`）核心一律建成 `<img>`，无法用扩展名判断
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return clean;
	return hasImageExtension(clean) ? clean : null;
}

function hasImageExtension(target: string): boolean {
	const dot = target.lastIndexOf('.');
	return dot > 0 && IMAGE_EXTENSIONS.has(target.slice(dot + 1).toLowerCase());
}

/**
 * 图片：单行区间。
 *
 * 三条行级排除都来自真机实测（命中它们时核心不建 `.image-embed`，放进候选就是「能翻到、
 * 但永远没有图标」的幽灵条目）：4 空格缩进会被当成缩进代码块；表格由 `.cm-table-widget`
 * 自己画、单元格里根本没有 `.image-embed`；行内 HTML widget 里的图片是 `span` 且没有
 * `.embed-actions`。
 *
 * 行内 HTML 那条要在**取出图片语法之后**再判：`![x](<带空格.png>)` 的角括号是 CommonMark
 * 允许的 target 写法，核心照样给它在 `.cm-line` 里建 `div.image-embed` + `.embed-actions`
 * （真机实测），按原行判会被自己的角括号误伤 —— 那样按钮被注入、候选却缺失，点了没反应。
 *
 * 排在 `MATCHERS` 最后：Callout / 围栏 / `$$` / HTML 块会先吃掉整段，所以 Callout 体内的图片
 * 不会另算一条（由外层 Callout 覆盖）。
 */
function matchImageBlock(lines: readonly string[], start: number): BlockMatch | null {
	const line = lines[start] ?? '';
	if (/^ {4,}/.test(line)) return null;
	if (line.trimStart().startsWith('|')) return null;

	const wiki = WIKI_EMBED.exec(line);
	const md = wiki ? null : MD_IMAGE.exec(line);
	const target = wiki ? wikiImageTarget(wiki[1] ?? '') : md ? pathImageTarget(md[1] ?? '') : null;
	const hit = wiki ?? md;
	if (!target || !hit) return null;

	// 命中片段之外的文字里若还有标签，说明这张图在行内 HTML widget 内（没有 `.embed-actions`）
	const rest = line.slice(0, hit.index) + line.slice(hit.index + hit[0].length);
	if (HTML_TAG.test(rest)) return null;

	// raw 只存命中的那段语法：整行喂给 MarkdownRenderer 会多出一层引用块 / 列表项
	return { kind: 'image', endLine: start, include: true, raw: hit[0] };
}

/** 同一行的类别优先级：`$$`、围栏、`> [!`、`<tag>` 互斥；图片排在最后（外层优先）。 */
const MATCHERS: ReadonlyArray<(lines: readonly string[], start: number) => BlockMatch | null> = [
	matchMathBlock,
	matchFencedBlock,
	matchCallout,
	matchHtmlBlock,
	matchImageBlock,
];

/**
 * 单趟扫描全文，按文档顺序返回五类区间。
 *
 * 命中任一起始判据就吃下整段区间，然后从区间末尾继续 —— 因此区间**天然不重叠、外层优先**。
 * 这一条是必需的，不是优化：Callout 里嵌的代码块在 Live Preview 里不会生成独立的
 * `.cm-embed-block`（它由 Callout 的渲染器画出来），若也当候选就会出现「能翻到、但永远没有图标」的幽灵条目。
 */
export function scanTextBlocks(text: string): TextBlockRegion[] {
	const lines = text.split('\n');
	const regions: TextBlockRegion[] = [];

	for (let start = 0; start < lines.length; start++) {
		let match: BlockMatch | null = null;
		for (const matcher of MATCHERS) {
			match = matcher(lines, start);
			if (match) break;
		}
		if (!match) continue;

		if (match.include) {
			regions.push({
				kind: match.kind,
				startLine: start,
				endLine: match.endLine,
				raw: match.raw ?? lines.slice(start, match.endLine + 1).join('\n'),
			});
		}
		start = match.endLine;
	}
	return regions;
}
