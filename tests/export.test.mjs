/**
 * `export.ts` 纯函数层的行为用例 —— 文件名、MIME、质量与倍率的夹取。
 *
 * 这里守的是两条对外承诺：
 * 1. **复制到剪贴板恒为 PNG**（Chromium 的异步剪贴板拒收 `image/jpeg`），下载才跟着格式设置走；
 * 2. **任何越界 / 非法值都回落成可用值**，导出设置不会带着 `undefined` / `NaN` 走进截图库。
 *
 * 刻意没测：`capturePopupImage` / `capturePopupPage` / `copyCanvasToClipboard` / `saveCanvasToVault`
 * 这些 DOM 层（要真实 DOM、真实剪贴板与真实 vault），它们按 Plan §9 走真机验证。
 * 页面组里能抽出来的纯几何（`computePageCrop`）与文件名范围后缀在这里守住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	DEFAULT_EXPORT_QUALITY,
	DEFAULT_EXPORT_SCALE,
	EXPORT_QUALITY_MAX,
	EXPORT_QUALITY_MIN,
	EXPORT_SCALE_MAX,
	EXPORT_SCALE_MIN,
	buildExportFileName,
	clampExportQuality,
	clampExportScale,
	computePageCrop,
	resolveCopyMime,
	resolveDownloadMime,
} = await jiti.import('../src/export.ts');

// —— MIME ——

test('复制恒为 PNG，与格式设置无关', () => {
	assert.equal(resolveCopyMime(), 'image/png');
});

test('下载按格式设置：jpg → image/jpeg，其余 → image/png', () => {
	assert.equal(resolveDownloadMime('jpg'), 'image/jpeg');
	assert.equal(resolveDownloadMime('png'), 'image/png');
	assert.equal(resolveDownloadMime('webp'), 'image/png', '非法值回落 PNG');
	assert.equal(resolveDownloadMime(undefined), 'image/png', '缺失值回落 PNG');
});

// —— 文件名 ——

test('文件名是「笔记名-YYYYMMDD-HHmmss.ext」，时间戳补零', () => {
	const at = new Date(2026, 8, 26, 9, 5, 3);
	assert.equal(buildExportFileName('我的笔记', 'png', at), '我的笔记-20260926-090503.png');
	assert.equal(buildExportFileName('note', 'jpg', at), 'note-20260926-090503.jpg');
});

test('文件名里的非法字符被替换成 -，不删字符（避免两个名字撞在一起）', () => {
	const at = new Date(2026, 8, 26, 9, 5, 3);
	assert.equal(buildExportFileName('a/b:c*d?e"f<g>h|i', 'png', at), 'a-b-c-d-e-f-g-h-i-20260926-090503.png');
});

test('笔记名为空 / 全是分隔符时兜底成 Untitled', () => {
	const at = new Date(2026, 8, 26, 9, 5, 3);
	assert.equal(buildExportFileName('', 'png', at), 'Untitled-20260926-090503.png');
	// 三个 / 换成三个 -，再接上分隔用的那个 -，共四个
	assert.equal(buildExportFileName('///', 'png', at), '----20260926-090503.png', '替换后非空，不兜底');
	assert.equal(buildExportFileName('  ', 'png', at), 'Untitled-20260926-090503.png', '纯空白等同空');
});

test('末尾的点被去掉（Windows 下会以点结尾的文件名出问题）', () => {
	const at = new Date(2026, 8, 26, 9, 5, 3);
	assert.equal(buildExportFileName('笔记.', 'png', at), '笔记-20260926-090503.png');
});

test('文件名带范围后缀：content / page', () => {
	const at = new Date(2026, 8, 26, 9, 5, 3);
	assert.equal(
		buildExportFileName('我的笔记', 'png', at, 'content'),
		'我的笔记-20260926-090503-content.png',
	);
	assert.equal(
		buildExportFileName('我的笔记', 'jpg', at, 'page'),
		'我的笔记-20260926-090503-page.jpg',
	);
	assert.equal(
		buildExportFileName('我的笔记', 'png', at),
		'我的笔记-20260926-090503.png',
		'省略 scope 时与加它之前完全一致（回归护栏）',
	);
});

// —— 页面组的裁切几何（方案 §2.2）——

test('内容高于一屏、滚到中段：裁掉的正是 padding', () => {
	const { sx, sy } = computePageCrop({
		innerLeft: 16,
		innerTop: 16,
		scrollLeft: 0,
		scrollTop: 1200,
	});
	assert.equal(sy, 1184, '页面盒上边缘 = 内容图第 1184px 处');
	assert.equal(sx, -16, '没横向滚动时，页面盒左边在内容图左边缘外 16px（padding）');
});

test('内容矮于屏、居中：sy 为负，靠 drawImage 的比例裁剪 + 底色补齐上下留白', () => {
	const { sy } = computePageCrop({ innerLeft: 0, innerTop: 266.5, scrollLeft: 0, scrollTop: 0 });
	assert.equal(sy, -266.5, '负值即「内容还没顶到盒顶」');
});

test('内容正好满屏 / 图片态 padding 为 0：不裁', () => {
	const { sx, sy } = computePageCrop({
		innerLeft: 0,
		innerTop: 0,
		scrollLeft: 0,
		scrollTop: 0,
	});
	assert.equal(sy, 0);
	assert.equal(sx, 0);
});

test('横向：长代码块滚到中段 → sx 为正；内容窄于屏宽 → sx 为负', () => {
	assert.equal(
		computePageCrop({ innerLeft: 16, innerTop: 16, scrollLeft: 400, scrollTop: 0 }).sx,
		384,
	);
	assert.equal(
		computePageCrop({ innerLeft: 200, innerTop: 16, scrollLeft: 0, scrollTop: 0 }).sx,
		-200,
	);
});

test('两个方向互不干扰：改横向滚动不动 sy，改纵向滚动不动 sx', () => {
	const base = { innerLeft: 16, innerTop: 16, scrollLeft: 0, scrollTop: 0 };
	const horizontal = computePageCrop({ ...base, scrollLeft: 400 });
	const vertical = computePageCrop({ ...base, scrollTop: 1200 });
	assert.equal(horizontal.sy, base.scrollTop - base.innerTop, '只动横向时 sy 与基准一致');
	assert.equal(vertical.sx, base.scrollLeft - base.innerLeft, '只动纵向时 sx 与基准一致');
});

// —— 质量与倍率的夹取 ——

test('质量夹在 0.1 ~ 1，非法值回落默认', () => {
	assert.equal(clampExportQuality(0.5), 0.5, '区间内原样保留');
	assert.equal(clampExportQuality(0), EXPORT_QUALITY_MIN, '下越界');
	assert.equal(clampExportQuality(2), EXPORT_QUALITY_MAX, '上越界');
	assert.equal(clampExportQuality(NaN), DEFAULT_EXPORT_QUALITY, 'NaN');
	assert.equal(clampExportQuality('0.5'), DEFAULT_EXPORT_QUALITY, '字符串');
	assert.equal(clampExportQuality(undefined), DEFAULT_EXPORT_QUALITY, '缺失');
});

test('倍率夹在 1 ~ 4，并按 0.5 的步长落在网格上', () => {
	assert.equal(clampExportScale(2), 2, '区间内原样保留');
	assert.equal(clampExportScale(1.3), 1.5, '不在网格上时取最近的档');
	assert.equal(clampExportScale(0.2), EXPORT_SCALE_MIN, '下越界');
	assert.equal(clampExportScale(99), EXPORT_SCALE_MAX, '上越界');
	assert.equal(clampExportScale('3'), DEFAULT_EXPORT_SCALE, '字符串回落默认');
	assert.equal(clampExportScale(undefined), DEFAULT_EXPORT_SCALE, '缺失回落默认');
	assert.ok(
		Number.isInteger(clampExportScale(3.7) / 0.5),
		'夹取结果始终落在 0.5 的步长网格上',
	);
});
