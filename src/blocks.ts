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
 * （见 scanner/shared.ts 的 `IMAGE_SELECTOR`）。它另有四条**行级排除**（缩进 / 表格 /
 * 行内 HTML / 行内代码），判据都是「实测核心不给这种写法建 `.image-embed`」。
 *
 * 第 6 类 `quote`（普通 Markdown 引用块 `> …`）是唯一**既没有容器、也没有原生图标**的一类：
 * 实时预览里它只是一串 `.cm-line.HyperMD-quote`（实测普通引用行上一条 `.cm-embed-block`
 * 都没有），所以既没有现成的 `.embed-actions` 可以插，也不能往行里插 DOM（会被 CM6 的
 * DOMObserver 当成文档变更冲掉）—— 它的图标由 `scanner/quote.ts` 的 CodeMirror 装饰器承载。
 * 本文件对它只负责「算出一条候选」，与另外五类同源。
 *
 * 第 7 类 `table`（Markdown 表格）**有**容器：核心给表格 widget 建的容器带 `.cm-embed-block`
 * （`cm-embed-block cm-table-widget markdown-rendered`，真机实测），所以既有遍历天然扫得到；
 * 但它**没有** `.embed-actions`（核心的 `addEditButton` 不给表格调用），图标容器得自己建
 * （见 scanner/inject.ts 的 `injectTableAction`）。起始判据直接复用 `convert/forward-table.ts`
 * 的 `matchTable` —— 两处判据漂移就会产出本仓库最忌讳的「有图标却翻不到」的幽灵。
 *
 * 为什么不用 DOM：Live Preview 只把视口附近的行渲染成 DOM，滚出视口的块连按钮都没有，
 * 于是「能翻到几条」会随滚动变化。数量必须是笔记的属性，不能是屏幕的属性。
 */

import { matchTable } from './convert/forward-table';

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

/** 可放大的区块类别。`html` = 用户手写的块级原始 HTML，其余六类是 Obsidian 原生区块。 */
export type BlockKind = 'html' | 'code' | 'callout' | 'math' | 'image' | 'quote' | 'table';

/** 一个可放大区间；行号 0 起，与 Editor 的行号一致。 */
export interface TextBlockRegion {
	kind: BlockKind;
	startLine: number;
	endLine: number;
	/**
	 * 该区间的原始文本，与核心 widget 的输入一致：前四类含围栏 / `> ` 前缀 / `$$`，
	 * 引用块含每行的 `> ` 前缀（喂给 `MarkdownRenderer` 正好渲染成一个 `<blockquote>`）；
	 * 表格就是那几行 `| a | b |` 原文（`MarkdownRenderer` 会认出表格）；
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
 * 引用块：连续以 `>` 开头的行算一段（第 6 类）。
 *
 * 三条位置 / 取舍都来自真机实测（见 Plan-20260920-090604 §2）：
 * 1. 排在 `matchCallout` **之后**：`> [!note]` 是 Callout，先被上面那类吃掉（Callout 仍是一条候选）。
 * 2. 排在 `matchImageBlock` **之前**：引用行里的图片不再单独成条 —— 一个视觉块只出一条候选、
 *    只挂一个图标，与「Callout 内的图片不单独成条」一致。
 * 3. 只认 `>` 前缀，不认懒惰续行：`> a` 的下一行写 `b`（实测带 `HyperMD-quote-lazy`，仍画在
 *    引用条里）时不并入区间 —— 与 `matchCallout` 的既有取舍一致，宁可少收一行，也不引入
 *    一套近似 CommonMark 的启发式。
 *
 * `raw` 不需要覆写（默认就是整段原文，保留每行的 `> ` 前缀）：`> a\n> b` 喂给
 * `MarkdownRenderer` 正好渲染成一个 `<blockquote>`，弹窗里因此带引用条。
 */
function matchQuoteBlock(lines: readonly string[], start: number): BlockMatch | null {
	if (!QUOTE_LINE.test(lines[start] ?? '')) return null;

	let end = start;
	while (end + 1 < lines.length && QUOTE_LINE.test(lines[end + 1] ?? '')) end++;
	return { kind: 'quote', endLine: end, include: true };
}

/**
 * 一行里被行内代码（反引号）覆盖的字符区间 `[start, end)`，按位置升序、互不重叠。
 * 四条规则全来自真机实测（见 Plan-20260920-101324 §2.2）：
 * 1. 反引号串 = 连续 n 个 `` ` ``；开启一段代码，找到**长度相同**的下一串就在那里闭合
 *    （与 CommonMark 一致）。
 * 2. 同一行里找不到等长的那一串时，这一段**一直延伸到行尾** —— 这是 Live Preview 特有的，
 *    未闭合的反引号也当代码（实测 `` `abc ![[x]] `` 整段是 `span.cm-inline-code`，
 *    没有 `.image-embed`）。注意阅读视图相反：那里反引号是字面文本、图会显示出来。
 * 3. 前面有**奇数个**反斜杠的反引号被转义，不参与（实测 `` \` ![[x]] `` 里的图照常出）。
 * 4. 代码段**不跨行**（实测 `` `abc `` 的下一行 `![[x]]` 照常出图）—— 所以逐行判断是完备的。
 *
 * 只回答「这一段字符是不是代码」，不做 markdown-it 那样的嵌套 / 转义还原：
 * 这里是「判断位置」，不是「解析内容」。
 */
function inlineCodeRanges(line: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let index = 0;
	while (index < line.length) {
		if (line[index] !== '`') {
			index += 1;
			continue;
		}
		// 奇数个反斜杠 = 被转义；偶数个是「转义的反斜杠 + 一个真反引号」
		let slashes = 0;
		while (line[index - 1 - slashes] === '\\') slashes += 1;
		if (slashes % 2 === 1) {
			index += 1;
			continue;
		}

		let open = 0;
		while (line[index + open] === '`') open += 1;

		// 规则 2：默认吃到行尾；找到等长闭合串就收在那里
		let cursor = index + open;
		let end = line.length;
		while (cursor < line.length) {
			if (line[cursor] !== '`') {
				cursor += 1;
				continue;
			}
			let run = 0;
			while (line[cursor + run] === '`') run += 1;
			if (run === open) {
				end = cursor + open;
				break;
			}
			cursor += run;
		}

		ranges.push([index, end]);
		index = end; // 跳到这一段之后：天然不嵌套、不重叠
	}
	return ranges;
}

/**
 * 取这一行里第一个**不在行内代码区间内**的匹配（找不到返回 null）。
 *
 * 为什么是「跳过」而不是「一旦在代码里就整行放弃」：同一行里「代码里的图 + 后面的真图」是
 * 合法写法，后面的真图**有 `.image-embed`、有放大图标**（真机实测）。整行放弃会让那张真图的
 * 图标点开时定位不到候选 —— `locateStartIndex` 对不上就**不开弹窗**，等于把「能翻到却没图标」
 * 的幽灵换成「有图标却点不开」的另一种幽灵。
 */
function firstHitOutsideCode(
	line: string,
	re: RegExp,
	ranges: ReadonlyArray<[number, number]>,
): RegExpExecArray | null {
	const global = new RegExp(re.source, 'g'); // WIKI_EMBED / MD_IMAGE 不带 g，这里要全局找
	for (let match = global.exec(line); match; match = global.exec(line)) {
		// 先提出成 const：闭包里对 let 的收窄不生效（`match` 在回调里会是 `RegExpExecArray | null`）
		const at = match.index;
		if (!ranges.some(([start, end]) => at >= start && at < end)) return match;
	}
	return null;
}

/**
 * 图片：单行区间。
 *
 * 四条行级排除都来自真机实测（命中它们时核心不建 `.image-embed`，放进候选就是「能翻到、
 * 但永远没有图标」的幽灵条目）：4 空格缩进会被当成缩进代码块；表格由 `.cm-table-widget`
 * 自己画、单元格里根本没有 `.image-embed`；行内 HTML widget 里的图片是 `span` 且没有
 * `.embed-actions`；**行内代码**里的图片在 LP 里只是一段文字（实测 `span.cm-inline-code`，
 * 没有 `.image-embed`）—— 这四条是同一族。
 *
 * 行内代码那条要在**取出图片语法之前**先算区间：反引号本身在 LP 的 DOM 里是被隐藏的格式符，
 * 文本扫描器看不到「这里被反引号包着」，只能自己按 `inlineCodeRanges` 的规则算。
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

	const ranges = inlineCodeRanges(line);
	const wiki = firstHitOutsideCode(line, WIKI_EMBED, ranges);
	const md = wiki ? null : firstHitOutsideCode(line, MD_IMAGE, ranges);
	const target = wiki ? wikiImageTarget(wiki[1] ?? '') : md ? pathImageTarget(md[1] ?? '') : null;
	const hit = wiki ?? md;
	if (!target || !hit) return null;

	// 命中片段之外的文字里若还有标签，说明这张图在行内 HTML widget 内（没有 `.embed-actions`）
	const rest = line.slice(0, hit.index) + line.slice(hit.index + hit[0].length);
	if (HTML_TAG.test(rest)) return null;

	// raw 只存命中的那段语法：整行喂给 MarkdownRenderer 会多出一层引用块 / 列表项
	return { kind: 'image', endLine: start, include: true, raw: hit[0] };
}

/**
 * 表格：判据 = `convert/forward-table.ts` 的 `matchTable` + 一条**实测补丁**（第 7 类）。
 *
 * 为什么要复用 `matchTable`：它的主力判据（表头行必须起一个块 / 分隔行必须合法 / 数据行吃到
 * 第一个终止行）已经与实时预览吻合（Plan-20260921-090329 §2.6 的 10 个写法实测表），另写一份
 * 就会漂移 —— 判据一旦放宽，就会产出「候选里有一条、编辑器里却没有 `.cm-table-widget`」的
 * 幽灵条目（点开图标都找不到）。
 *
 * 为什么要补一条：`matchTable` 只拒绝 **≥4 空格**的缩进（`hasCodeIndent`），而实时预览要求
 * 表头行**顶格**。真机实测（本次落地时用探针笔记量过，整个文档都在视口内）：
 *   - `  | a | b |` 开头（文档第一行 / 空行后 / 列表项延续，1/2/3 空格都试过）→ 没有
 *     `.cm-table-widget`，那两行只是 `HyperMD-list-line-nobullet` 的普通文字；
 *   - 同样内容的**顶格**写法 → 有 `.cm-table-widget`（含「列表 + 空行 + 顶格表」这种对照，
 *     实测照样有 widget，所以判据不是「在列表里」而是「有没有前导空白」）。
 * 不补这条就会多出一类幽灵：列表项延续的表（`- item` + 空行 + 2 空格缩进的表）在扫描器里
 * 是一条候选，编辑器里却没有图标可点。
 *
 * `matchTable` 会做完整的单元格切分，扫描里只用它的 `end`（区间右边界），属于可接受的冗余。
 * 依赖方向不成环：`convert/*` 不 import `../blocks`，只 import 同目录的 `forward-*` 与 `shared`。
 *
 * 排在 `matchImageBlock` **之前**：两者互斥（`matchImageBlock` 见到 `|` 开头直接返回 null），
 * 前置只是让「表格里的图片不单独成条」这条口径不依赖那个内部守卫。
 */
function matchTableBlock(lines: readonly string[], start: number): BlockMatch | null {
	if (/^[ \t]/.test(lines[start] ?? '')) return null; // 顶格才是实时预览认的表格
	const table = matchTable(lines, start);
	if (!table) return null;
	// matchTable 的 end 是「表格结束后的下一行下标」，区间要的是含末行的行号
	return { kind: 'table', endLine: table.end - 1, include: true };
}

/** 同一行的类别优先级：`$$`、围栏、`> [!`、`<tag>` 互斥；引用排在图片之前（外层优先）。 */
const MATCHERS: ReadonlyArray<(lines: readonly string[], start: number) => BlockMatch | null> = [
	matchMathBlock,
	matchFencedBlock,
	matchCallout,
	matchHtmlBlock,
	matchQuoteBlock,
	matchTableBlock,
	matchImageBlock,
];

/**
 * 单趟扫描全文，按文档顺序返回七类区间。
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
