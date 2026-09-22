/**
 * 弹窗样式回归用例 —— 目前钉住五条：表格字号（V109 修复，2026-09-18）、视图缩放的 transform
 * （V116 第四次反馈「Zoom out 抖动」＋第五次反馈「Zoom in 抖动」的修复，2026-09-20）、
 * 表格放大图标的悬停显隐（V117，2026-09-21）、弹窗图片的尺寸口径（V118，2026-09-21）
 * 与 Canvas 嵌入那两条（V119，2026-09-22）。
 *
 * 背景：核心给单元格直接写了字号
 * （`.markdown-rendered td { font-size: var(--table-text-size) }`、
 *   `.markdown-rendered th { font-size: var(--table-header-size) }`），
 * 而这两个变量在 `:root` 就解析成了 `--font-text-size` 的当前值 —— 是**绝对像素**，
 * 不再随祖先的 `font-size` 变化。弹窗的「字号 / 缩放」只改 `--text-popup-font-size`
 * （见 modal.ts 的 updateSize），于是传不进单元格：真机实测弹窗正文 30px 时 th / td 仍是 16px。
 *
 * styles.css 里那条 `font-size: inherit` 是唯一修复点，删掉它 bug 会静默回来；
 * 本仓库没有能跑真实样式的 DOM 环境（`tests/convert.test.mjs` 覆盖的是转换逻辑），
 * 所以用最小代价把这把尺子钉住：
 *   ① 单元格必须跟随弹窗字号；
 *   ② 这条覆盖必须限定在弹窗内 —— 真机实测编辑器 / 阅读视图里的表格应由 App 正文字号决定（16px），
 *      丢了这个作用域就会把它们一起改掉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** styles.css 里目前没有 @media / @supports，展平解析即可。 */
const CSS = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
	// 先去注释：注释里也会出现 `font-size: inherit` 这样的字面量
	.replace(/\/\*[\s\S]*?\*\//g, '');

/** 全部 `选择器 { 声明 }` 规则。 */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList, body]) => ({
	selectors: selectorList.split(',').map((selector) => selector.trim()),
	body: body.trim(),
}));

/** 把字号交还给继承的两种等价写法。 */
const FOLLOWS_POPUP_SIZE = /font-size\s*:\s*(inherit|var\(\s*--text-popup-font-size\s*\))/;

/** 选择器里是否出现标签 `tag` 这个 token（`td` 命中 `td:hover`，不命中 `.td-x`）。 */
function hasTagToken(selector, tag) {
	return new RegExp(`(^|[\\s>+~,(])${tag}(?![\\w-])`).test(selector);
}

test('弹窗内的表格单元格跟随弹窗字号：th 与 td 各有一条覆盖', () => {
	for (const cell of ['th', 'td']) {
		const hit = RULES.some(
			(rule) =>
				FOLLOWS_POPUP_SIZE.test(rule.body) &&
				rule.selectors.some(
					(selector) => selector.includes('.mod-text-popup') && hasTagToken(selector, cell),
				),
		);
		assert.ok(
			hit,
			`styles.css 缺少弹窗内 \`${cell}\` 的字号覆盖，表格文字会退回 App 正文字号（--font-text-size）`,
		);
	}
});

test('单元格字号覆盖必须限定在弹窗内，不能影响编辑器与阅读视图', () => {
	const leaked = RULES.filter((rule) =>
		rule.selectors.some(
			(selector) => hasTagToken(selector, 'th') || hasTagToken(selector, 'td'),
		),
	).filter((rule) => rule.selectors.some((selector) => !selector.includes('.mod-text-popup')));

	assert.deepEqual(
		leaked.map((rule) => rule.selectors.join(', ')),
		[],
		'styles.css 里出现了不带 .mod-text-popup 作用域的 th / td 规则，会波及编辑器与阅读视图',
	);
});

/**
 * 视图缩放那条 transform 必须同时挂上平移补偿，而且 `translate` 要写在 `scale` **左边**。
 *
 * 滚动量是会被浏览器夹住的量：可滚区间是随 scale 变的（zoom out 时随缩小塌到 0、zoom in 时要等
 * 放大到 scale≈1.19 才出现），被夹掉的那一截只能由 transform 的平移顶上（见 modal.ts 的
 * resolveViewFrame）。两个坑都在这条断言里：
 *   ① 删掉 translate 会让缩放的抖动静默回来（真机实测 Zoom out 横向甩回 101px、Zoom in 反向漂出
 *      155px，Report-20260920-202610 / Report-20260920-223435）；
 *   ② transform 从右往左作用，写成 `scale() translate()` 时平移量会被 scale 放大，补偿的数值全错。
 */
test('视图缩放的 transform 同时挂 scale 与平移补偿，且 translate 在 scale 左边', () => {
	const rule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) => selector.includes('.is-view-zoomed') && selector.includes('.text-popup-text'),
			) && /transform\s*:/.test(entry.body),
	);
	assert.ok(rule, 'styles.css 里找不到 `.is-view-zoomed .text-popup-text` 的 transform 规则');

	const transform = rule.body.slice(rule.body.indexOf('transform:'));
	const translate = transform.slice(transform.indexOf('translate('), transform.indexOf('scale('));
	assert.ok(
		/--text-popup-pan-x/.test(translate),
		'translate 里缺少 --text-popup-pan-x：滚动被夹住时内容会被钉住、再随 scale 反向甩回',
	);
	assert.ok(/--text-popup-pan-y/.test(translate), 'translate 里缺少 --text-popup-pan-y（纵轴同样会被夹）');
	assert.ok(
		/scale\(\s*var\(\s*--text-popup-view-scale/.test(transform),
		'transform 缺少 --text-popup-view-scale 的缩放',
	);
	assert.ok(
		0 < transform.indexOf('translate(') && transform.indexOf('translate(') < transform.indexOf('scale('),
		'translate 必须写在 scale 左边：transform 从右往左作用，落到缩放结果上才是屏幕像素',
	);
	assert.ok(
		/transform-origin\s*:\s*0\s+0/.test(rule.body),
		'transform-origin 必须留在 0 0（点击处左上方的内容要能滚回来，见 styles.css 的注释）',
	);
});

/**
 * 表格的放大图标（V117）必须有一条自己写的悬停显隐规则。
 *
 * 背景：核心的显隐规则写在 `@media (hover: hover)` 里，且**显式排除表格** ——
 * `app.css:12155` 的 `.cm-embed-block:not(.cm-table-widget, .cm-lang-base):hover .embed-actions`。
 * 表格的图标容器又是本插件自己建的（核心不给表格调 `addEditButton()`），所以没有这条规则时
 * 容器永远停在核心给的 `opacity: 0`：图标在 DOM 里、点了也有效，但用户**看不见**。
 *
 * 两条纪律：
 *   ① 必须带 `.markdown-source-view.mod-cm6` 前缀 —— 核心那条 `opacity: 0` 就是同前缀的
 *      `.markdown-source-view.mod-cm6 .embed-actions`，不带前缀压不住（与引用块那条同源）；
 *   ② 必须是 `:hover` 触发（悬停表格才显形，与核心对 Callout / 数学块 / 图片一致）。
 */
test('表格的放大图标有一条带编辑器前缀的悬停显隐规则', () => {
	const rule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) =>
					selector.includes('.markdown-source-view.mod-cm6') &&
					selector.includes('.cm-table-widget') &&
					selector.includes(':hover') &&
					selector.includes('.embed-actions'),
			) && /opacity\s*:\s*1/.test(entry.body),
	);

	assert.ok(
		rule,
		'styles.css 缺少 `.markdown-source-view.mod-cm6 .cm-table-widget:hover .embed-actions { opacity: 1 }`：' +
			'核心那条显隐规则用 :not(.cm-table-widget) 把表格排除了，少了它表格图标永远不显形',
	);
});

/**
 * 弹窗图片必须与核心 lightbox 同口径：按可用高度**装下**（不滚）、且忽略 Markdown 尺寸语法。
 *
 * 两条病症（用户 V118 报的）都在这条断言里：
 *   ① 删掉 `max-height` → 回到「只按宽度铺满、纵向要往下滚」（1210×1009 的图实测要滚 189px）；
 *   ② 删掉 `width/height: auto` → 核心按尺寸语法写在 img 上的 width / height 属性又生效
 *      （`|600x200` 会渲染成 600×200，比例被压坏）。
 * `max-height` 用 `100cqh` 而不是 `100%`：图片的包含块是正文里的 `<p>`、高度 auto，百分比会解析成
 * none（核心能写 100% 是因为 .media-wrapper 明写了 height: 100%）。所以还必须有第二条：
 *   `.text-popup-content` 上的 `container-type: size` —— 丢了它 `cqh` 的参照会退回**视口**（离屏实测
 *   400px 高的宿主里 max-height 算成 833.333px、图片当场溢出）。今天弹窗恰好铺满窗口所以数值碰巧相等，
 *   一旦弹窗不再铺满（或控制条不再隐藏）图片就会按视口高算歪。
 *
 * 尺寸类的判据靠真机核对（本仓库没有能跑真实样式的 DOM 环境，见文件头），这里只钉住「CSS 是否还在」。
 */
test('弹窗图片按可用高度装下并忽略尺寸语法，且 cqh 的参照物仍在', () => {
	const imgRule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) =>
					selector.includes('.mod-text-popup') &&
					selector.includes('.is-rich') &&
					hasTagToken(selector, 'img'),
			) && /max-width\s*:/.test(entry.body),
	);
	assert.ok(imgRule, 'styles.css 里找不到 `.mod-text-popup .text-popup-text.is-rich img` 的尺寸规则');

	assert.ok(
		/max-height\s*:\s*[^;]*cqh/.test(imgRule.body),
		'图片规则缺少 `max-height: 100cqh`：没有高度约束会退回「只按宽度铺满、纵向要往下滚」',
	);
	assert.ok(
		/width\s*:\s*auto/.test(imgRule.body) && /height\s*:\s*auto/.test(imgRule.body),
		'图片规则缺少 `width/height: auto`：核心按 Markdown 尺寸语法写在 img 上的属性会重新生效（|600x200 会变形）',
	);
	assert.ok(
		imgRule.selectors.every((selector) => selector.includes('.mod-text-popup')),
		'图片尺寸规则必须带 .mod-text-popup 作用域，否则会波及编辑器与阅读视图里的图片',
	);

	const containerRule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) => selector.includes('.mod-text-popup') && selector.includes('.text-popup-content'),
			) && /container-type\s*:\s*size/.test(entry.body),
	);
	assert.ok(
		containerRule,
		'`.mod-text-popup .text-popup-content` 缺少 `container-type: size`：`100cqh` 的参照会退回视口，' +
			'弹窗不铺满一屏时图片就会按视口高度算歪',
	);
});

/**
 * Canvas 嵌入的放大图标（V119）必须有自己的**定位基准**与**悬停显隐** —— 与 Excalidraw 那类不同，
 * Canvas 这两条核心一条都没给（Excalidraw 的 `.image-embed` 自带 `position: relative`、
 * 也在核心的悬停规则里，零 CSS 即可）。
 *
 * 两条缺失各自的病症（真机实测）：
 *   ① 丢 `position: relative` → 容器补上核心的 `position: absolute` 后会以**最近的定位祖先**
 *      为基准 —— 实测是 `.cm-scroller`，按钮贴到整个滚动区右上角（画布恰好占满行宽时看着还行，
 *      画布窄一点就飘到画布外）。核心的 `.cm-embed-block` 与 `.cm-line > .image-embed` 都自带
 *      `position: relative`，`.canvas-embed` 两条都不沾。
 *   ② 丢悬停规则 → 容器永远停在核心给的 `opacity: 0`：图标在 DOM 里、点了也有效，但用户看不见。
 *      核心的显隐只有 `.cm-embed-block:hover` 与 `.cm-content .image-embed:hover` 两条，
 *      `.canvas-embed` 不在其中。
 *
 * 两条都必须带 `.markdown-source-view.mod-cm6` 前缀 —— 核心那条 `opacity: 0` 就是同前缀的
 * `.markdown-source-view.mod-cm6 .embed-actions`，不带前缀压不住（与表格、引用块同源）。
 */
test('Canvas 嵌入的放大图标有定位基准与带编辑器前缀的悬停显隐', () => {
	const baseRule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) => selector.includes('.markdown-source-view.mod-cm6') && selector.endsWith('.canvas-embed'),
			) && /position\s*:\s*relative/.test(entry.body),
	);
	assert.ok(
		baseRule,
		'styles.css 缺少 `.markdown-source-view.mod-cm6 .canvas-embed { position: relative }`：' +
			'容器会以 .cm-scroller 为基准，按钮飘到整个滚动区的右上角',
	);

	const hoverRule = RULES.find(
		(entry) =>
			entry.selectors.some(
				(selector) =>
					selector.includes('.markdown-source-view.mod-cm6') &&
					selector.includes('.canvas-embed') &&
					selector.includes(':hover') &&
					selector.includes('.embed-actions'),
			) && /opacity\s*:\s*1/.test(entry.body),
	);
	assert.ok(
		hoverRule,
		'styles.css 缺少 `.markdown-source-view.mod-cm6 .canvas-embed:hover .embed-actions { opacity: 1 }`：' +
			'核心的悬停规则不含 .canvas-embed，少了它 Canvas 图标永远不显形',
	);
});
