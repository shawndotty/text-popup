/**
 * convert 模块对外门面。
 *
 * 重新导出 8 个公开符号，外部调用方的 `import … from './convert'` 无需改动。
 */

export { htmlToMarkdown } from './backward';
export { findOuterPopupElement } from './element';
export type { PopupElement } from './element';
export { hasBlockBody, hasTooDeepIndent, isSingleLine, markdownToHtml, MAX_POPUP_INDENT } from './forward-body';
