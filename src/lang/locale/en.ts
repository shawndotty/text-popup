/**
 * 英文词典 —— 既是 key 的**基准**（`keyof typeof en` 就是 `t()` 的参数类型），
 * 也是所有语言的**最终回退**（见 helpers.ts）。
 *
 * 约定：键与值相同；面向用户的文案一律 sentence case（`AGENTS.md` 的 UX & copy guidelines）。
 * 新增文案时先加在这里，再补 zh-cn / zh-tw；非英文词典是 `Partial<typeof en>`，可以增量补。
 */
export default {
	// —— 设置页 ——
	'Magnifier icon': 'Magnifier icon',
	'Enable magnifier icon': 'Enable magnifier icon',
	'Show a magnifier icon for supported blocks in Live Preview.':
		'Show a magnifier icon for supported blocks in Live Preview.',
	'Magnify code blocks': 'Magnify code blocks',
	'Show a magnifier icon for fenced code blocks in Live Preview.':
		'Show a magnifier icon for fenced code blocks in Live Preview.',
	'Magnify callouts': 'Magnify callouts',
	'Show a magnifier icon for callouts in Live Preview.':
		'Show a magnifier icon for callouts in Live Preview.',
	'Magnify math blocks': 'Magnify math blocks',
	'Show a magnifier icon for $$ math blocks in Live Preview.':
		'Show a magnifier icon for $$ math blocks in Live Preview.',
	'Magnify images': 'Magnify images',
	'Show a magnifier icon for images in Live Preview.':
		'Show a magnifier icon for images in Live Preview.',
	'Magnify quotes': 'Magnify quotes',
	'Show a magnifier icon for blockquotes in Live Preview.':
		'Show a magnifier icon for blockquotes in Live Preview.',
	'Magnify tables': 'Magnify tables',
	'Show a magnifier icon for Markdown tables in Live Preview.':
		'Show a magnifier icon for Markdown tables in Live Preview.',
	'Magnify canvases': 'Magnify canvases',
	'Show a magnifier icon for Canvas embeds in Live Preview, and render them as a read-only snapshot inside the popup.':
		'Show a magnifier icon for Canvas embeds in Live Preview, and render them as a read-only snapshot inside the popup.',
	'Popup content': 'Popup content',
	'Render HTML and Markdown': 'Render HTML and Markdown',
	"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.":
		"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.",
	'Excalidraw image fallback': 'Excalidraw image fallback',
	'Show Excalidraw embeds as same-name PNG/SVG images inside the popup. Requires Auto-export SVG and filename sync enabled in the Excalidraw plugin.':
		'Show Excalidraw embeds as same-name PNG/SVG images inside the popup. Requires Auto-export SVG and filename sync enabled in the Excalidraw plugin.',
	'Preferred Excalidraw image format': 'Preferred Excalidraw image format',
	'SVG is vector and scales losslessly with the popup zoom; PNG is raster. The fallback format is tried if the preferred one is missing.':
		'SVG is vector and scales losslessly with the popup zoom; PNG is raster. The fallback format is tried if the preferred one is missing.',
	'Follow the theme background': 'Follow the theme background',
	'Popup background color': 'Popup background color',
	'Color of the popup window.': 'Color of the popup window.',
	'Follow the theme text color': 'Follow the theme text color',
	'Popup text color': 'Popup text color',
	'Text color inside the popup body.': 'Text color inside the popup body.',
	'Popup font size': 'Popup font size',
	'Default font size inside the popup, in pixels. You can also adjust it inside the popup.':
		'Default font size inside the popup, in pixels. You can also adjust it inside the popup.',
	'On close': 'On close',
	'Locate the viewed block': 'Locate the viewed block',
	'When you close the popup, scroll the note to the block you were viewing. The cursor is not moved.':
		'When you close the popup, scroll the note to the block you were viewing. The cursor is not moved.',
	'Block wrappers': 'Block wrappers',
	'Supported tags': 'Supported tags',
	'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.':
		'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.',
	'Single-line wrapper tag': 'Single-line wrapper tag',
	'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.':
		'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.',
	'Multi-line wrapper tag': 'Multi-line wrapper tag',
	'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.':
		'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.',

	// —— 命令名 · 右键菜单项 ——
	'Popup selected text': 'Popup selected text',
	'Unpopup selected text': 'Unpopup selected text',
	'Show Popup In The Note': 'Show Popup In The Note',

	// —— Notice 提示 ——
	'Please use a single cursor.': 'Please use a single cursor.',
	'Wrapper tag unavailable. Check the wrapper tag settings and "Supported tags".':
		'Wrapper tag unavailable. Check the wrapper tag settings and "Supported tags".',
	'The selection is empty; nothing to convert.': 'The selection is empty; nothing to convert.',
	'The selection is indented too deeply and would be treated as a code block.':
		'The selection is indented too deeply and would be treated as a code block.',
	'The selection is inside a code block, callout, or math block.':
		'The selection is inside a code block, callout, or math block.',
	'The selection already contains a popup block; use the unpopup command first.':
		'The selection already contains a popup block; use the unpopup command first.',
	'The selection is not inside a magnifiable HTML block.':
		'The selection is not inside a magnifiable HTML block.',
	'The selection spans multiple popup blocks; only one can be restored at a time.':
		'The selection spans multiple popup blocks; only one can be restored at a time.',
	'No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.':
		'No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.',
	'No popup in the current note.': 'No popup in the current note.',

	// —— 弹窗控制条与标题兜底 ——
	'Font size': 'Font size',
	'Decrease font size': 'Decrease font size',
	'Increase font size': 'Increase font size',
	Zoom: 'Zoom',
	'Zoom out': 'Zoom out',
	'Zoom in': 'Zoom in',
	Reset: 'Reset',
	'Magnified view': 'Magnified view',

	// —— 弹窗过滤模式 ——
	'Filter blocks': 'Filter blocks',
	'Type to filter, @ for type': 'Type to filter, @ for type',
	Filtered: 'Filtered',

	// —— 放大图标的 aria-label ——
	'Magnify': 'Magnify',
};
