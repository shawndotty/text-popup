import type en from './en';

/**
 * 简体中文词典。`Partial<typeof en>`：允许只写一部分 key，缺的部分由 `helpers.ts` 回退英文 ——
 * 翻译可以增量补，不会因为漏一条就崩。键必须与 `en.ts` 完全一致（写错会在 `tsc` 阶段报错）。
 */
const zhCN: Partial<typeof en> = {
	// —— 设置页 ——
	'Enable magnifier icon': '启用放大图标',
	'Show a magnifier icon for supported blocks in Live Preview.':
		'在实时预览中，为支持的区块显示放大图标。',
	'Magnify code blocks': '放大代码块',
	'Show a magnifier icon for fenced code blocks in Live Preview.':
		'为实时预览里的围栏代码块显示放大图标。',
	'Magnify callouts': '放大 Callout',
	'Show a magnifier icon for callouts in Live Preview.':
		'为实时预览里的标注（Callout）显示放大图标。',
	'Magnify math blocks': '放大数学块',
	'Show a magnifier icon for $$ math blocks in Live Preview.':
		'为实时预览里的 $$ 数学块显示放大图标。',
	'Render HTML and Markdown': '渲染 HTML 与 Markdown',
	"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.":
		'在弹窗内按语法渲染块里的 HTML 与 Markdown。关闭后按纯文本原样显示。',
	'Popup background color': '弹窗背景色',
	'Leave empty to follow the theme background color.': '留空则跟随主题背景色。',
	'Popup text color': '弹窗文字颜色',
	'Leave empty to follow the theme text color.': '留空则跟随主题文字颜色。',
	'Popup font size': '弹窗字号',
	'Default font size inside the popup, in pixels. You can also adjust it inside the popup.':
		'弹窗内文字的默认字号，单位为像素。弹窗内还可以临时调整。',
	'Supported tags': '支持的标签',
	'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.':
		'只对手写的块级 HTML 生效，用逗号分隔，例如 div, p。修改后立即生效，不需要改代码。',
	'Single-line wrapper tag': '单行文本包裹标签',
	'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.':
		'选区只有一行时，转换命令用哪个块级标签包裹文本；只有块级标签能生成可放大的块。',
	'Multi-line wrapper tag': '多行文本包裹标签',
	'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.':
		'选区含换行（多行）时，转换命令用哪个块级标签包裹文本；只有块级标签能生成可放大的块。',
	'Follow theme': '跟随主题',

	// —— 命令名 · 右键菜单项 ——
	'Popup selected text': 'Popup选中文本',
	'Unpopup selected text': 'Unpopup选中文本',
	'Show Popup In The Note': '打开当前笔记的第一个 Popup',

	// —— Notice 提示 ——
	'Please use a single cursor.': '请在单光标下使用',
	'Wrapper tag unavailable. Check the wrapper tag settings and "Supported tags".':
		'包裹标签不可用，请在设置里检查「单行文本包裹标签」「多行文本包裹标签」与「支持的标签」',
	'The selection is empty; nothing to convert.': '选中的是空行，没有可转换的内容',
	'The selection is indented too deeply and would be treated as a code block.':
		'选区缩进太深，会被当成代码块，无法生成可放大的块',
	'The selection is inside a code block, callout, or math block.':
		'选区位于代码块、标注或数学块内，无法转换',
	'The selection already contains a popup block; use the unpopup command first.':
		'选区里已经有 Popup 块，请先用还原命令',
	'The selection is not inside a magnifiable HTML block.': '选区不在可放大的 HTML 块里',
	'The selection spans multiple popup blocks; only one can be restored at a time.':
		'选区跨了多个放大块，一次只能还原一个',
	'No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.':
		'没找到可还原的外层标签，只支持「支持的标签」里的块级标签',
	'No popup in the current note.': '当前笔记里没有可放大的区块',

	// —— 弹窗控制条与标题兜底 ——
	'Font size': '字号',
	'Decrease font size': '减小字号',
	'Increase font size': '增大字号',
	Zoom: '缩放',
	'Zoom out': '整体缩小',
	'Zoom in': '整体放大',
	Reset: '恢复默认',
	'Magnified view': '放大显示',

	// —— 放大图标的 aria-label ——
	'Magnify text': '放大显示文字',
};

export default zhCN;
