import type en from './en';

/**
 * 繁體中文詞典（台灣用語）。`Partial<typeof en>`：缺的 key 由 `helpers.ts` 回退英文。
 * 用詞務必遵循 Plan-20260918-104304 第 4.1 節術語表：圖示（非「圖標」）、程式碼（非「代碼」）、
 * 字型大小（非「字號」）、游標（非「光標」）、設定、區塊、即時預覽、預設、還原、標籤、支援。
 */
const zhTW: Partial<typeof en> = {
	// —— 設定頁 ——
	'Enable magnifier icon': '啟用放大圖示',
	'Show a magnifier icon for supported blocks in Live Preview.':
		'在即時預覽中，為支援的區塊顯示放大圖示。',
	'Magnify code blocks': '放大程式碼區塊',
	'Show a magnifier icon for fenced code blocks in Live Preview.':
		'為即時預覽裡的圍欄程式碼區塊顯示放大圖示。',
	'Magnify callouts': '放大 Callout',
	'Show a magnifier icon for callouts in Live Preview.':
		'為即時預覽裡的標註（Callout）顯示放大圖示。',
	'Magnify math blocks': '放大數學區塊',
	'Show a magnifier icon for $$ math blocks in Live Preview.':
		'為即時預覽裡的 $$ 數學區塊顯示放大圖示。',
	'Render HTML and Markdown': '渲染 HTML 與 Markdown',
	"Render the block's HTML and Markdown inside the popup. When off, the content is shown as plain text.":
		'在彈窗內依語法渲染區塊裡的 HTML 與 Markdown。關閉後以純文字原樣顯示。',
	'Popup background color': '彈窗背景色',
	'Leave empty to follow the theme background color.': '留空則跟隨主題背景色。',
	'Popup text color': '彈窗文字顏色',
	'Leave empty to follow the theme text color.': '留空則跟隨主題文字顏色。',
	'Popup font size': '彈窗字型大小',
	'Default font size inside the popup, in pixels. You can also adjust it inside the popup.':
		'彈窗內文字的預設字型大小，單位為像素。彈窗內還可以臨時調整。',
	'Supported tags': '支援的標籤',
	'Only applies to hand-written block-level HTML. Separate tags with commas, for example div, p. Changes take effect immediately, no code change needed.':
		'只對手寫的區塊層級 HTML 生效，以逗號分隔，例如 div, p。修改後立即生效，不需要改程式碼。',
	'Single-line wrapper tag': '單行文字包裹標籤',
	'Which block-level tag the conversion commands use when the selection is a single line. Only block-level tags can produce a magnifiable block.':
		'選取範圍只有一行時，轉換命令用哪個區塊層級標籤包裹文字；只有區塊層級標籤能產生可放大的區塊。',
	'Multi-line wrapper tag': '多行文字包裹標籤',
	'Which block-level tag the conversion commands use when the selection has line breaks. Only block-level tags can produce a magnifiable block.':
		'選取範圍含換行（多行）時，轉換命令用哪個區塊層級標籤包裹文字；只有區塊層級標籤能產生可放大的區塊。',
	'Follow theme': '跟隨主題',

	// —— 命令名 · 右鍵選單項目 ——
	'Popup selected text': 'Popup選取文字',
	'Unpopup selected text': 'Unpopup選取文字',

	// —— Notice 提示 ——
	'Please use a single cursor.': '請在單游標下使用',
	'Wrapper tag unavailable. Check the wrapper tag settings and "Supported tags".':
		'包裹標籤不可用，請在設定裡檢查「單行文字包裹標籤」「多行文字包裹標籤」與「支援的標籤」',
	'The selection is empty; nothing to convert.': '選取的是空行，沒有可轉換的內容',
	'The selection is indented too deeply and would be treated as a code block.':
		'選取範圍縮排太深，會被當成程式碼區塊，無法產生可放大的區塊',
	'The selection is inside a code block, callout, or math block.':
		'選取範圍位於程式碼區塊、標註或數學區塊內，無法轉換',
	'The selection already contains a popup block; use the unpopup command first.':
		'選取範圍裡已經有 Popup 區塊，請先使用還原命令',
	'The selection is not inside a magnifiable HTML block.': '選取範圍不在可放大的 HTML 區塊裡',
	'The selection spans multiple popup blocks; only one can be restored at a time.':
		'選取範圍跨了多個放大區塊，一次只能還原一個',
	'No restorable wrapper tag found; only block-level tags from "Supported tags" are supported.':
		'找不到可還原的外層標籤，只支援「支援的標籤」裡的區塊層級標籤',

	// —— 彈窗控制列與標題後備 ——
	'Font size': '字型大小',
	'Decrease font size': '縮小字型',
	'Increase font size': '放大字型',
	Zoom: '縮放',
	'Zoom out': '整體縮小',
	'Zoom in': '整體放大',
	Reset: '還原預設值',
	'Magnified view': '放大顯示',

	// —— 放大圖示的 aria-label ——
	'Magnify text': '放大顯示文字',
};

export default zhTW;
