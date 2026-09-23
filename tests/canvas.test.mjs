/**
 * `canvas.ts` 的纯函数用例 —— 画布 JSON → 模型 → 几何。
 *
 * 背景（详见 [[Plan-20260923-093506]]）：核心给 `![[x.canvas]]` 画的是一张 **minimap**
 * （只有轮廓、没有文字、没有交互），弹窗里等于「放大一张缩略图」。本插件改成自研只读快照，
 * 这个文件钉住它的第一层：**模型解析与几何算式**。第二层（DOM 渲染）需要真实 DOM 与
 * `MarkdownRenderer`，仓库里没有能跑真实渲染的环境（与 tests/styles.test.mjs 头注释同一条理由），
 * 交给真机验收。
 *
 * 样本取自仓库里那份真画布 `4-成果/Text Popup/Canvas/Canvas-20260923-084927.canvas`
 * （3 个 text 节点 + 2 条边，坐标含负数 —— 正是最容易被「忘了减原点」写错的那种）。
 *
 * 需要 obsidian 桩：`canvas.ts` 顶部 import 了 `MarkdownRenderer`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { obsidian: new URL('./stubs/obsidian.mjs', import.meta.url).pathname },
});
const {
	CANVAS_PADDING,
	canvasBounds,
	canvasEmbedText,
	edgeArrowPath,
	edgeEndpoints,
	edgePath,
	parseCanvasDocument,
} = await jiti.import('../src/canvas.ts');

/** 真画布的原文（只保留本用例关心的字段，结构与 `Canvas-20260923-084927.canvas` 一致）。 */
const SAMPLE = JSON.stringify({
	nodes: [
		{ id: 'a', x: -5, y: 67, width: 250, height: 60, type: 'text', text: 'Input' },
		{ id: 'b', x: -5, y: -140, width: 250, height: 60, type: 'text', text: 'Output' },
		{ id: 'c', x: -360, y: -60, width: 250, height: 60, type: 'text', text: 'IOTO' },
	],
	edges: [
		{ id: 'e1', fromNode: 'c', fromSide: 'right', toNode: 'a', toSide: 'left' },
		{ id: 'e2', fromNode: 'c', fromSide: 'right', toNode: 'b', toSide: 'left' },
	],
});

/** 造一个最小节点（几何用例只关心盒子与方位）。 */
function box(x, y, width, height) {
	return { id: `${x},${y}`, type: 'text', x, y, width, height };
}

// —— parseCanvasDocument ——

test('parseCanvasDocument 解析真画布结构（3 节点 + 2 边）', () => {
	const doc = parseCanvasDocument(SAMPLE);
	assert.ok(doc, '真样本必须解析成功');
	assert.equal(doc.nodes.length, 3);
	assert.equal(doc.edges.length, 2);
	assert.deepEqual(doc.nodes[0], {
		id: 'a',
		type: 'text',
		x: -5,
		y: 67,
		width: 250,
		height: 60,
		text: 'Input',
	});
	assert.deepEqual(doc.edges[0], {
		id: 'e1',
		fromNode: 'c',
		fromSide: 'right',
		toNode: 'a',
		toSide: 'left',
	});
});

test('parseCanvasDocument 保留 color / file / url / label，缺省时不塞空字段', () => {
	const doc = parseCanvasDocument(
		JSON.stringify({
			nodes: [
				{ id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, color: '4', label: '组' },
				{ id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'note.md' },
				{ id: 'l', type: 'link', x: 0, y: 0, width: 10, height: 10, url: 'https://a.b' },
				{ id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
			],
		}),
	);
	assert.ok(doc);
	assert.equal(doc.nodes[0].color, '4');
	assert.equal(doc.nodes[0].label, '组');
	assert.equal(doc.nodes[1].file, 'note.md');
	assert.equal(doc.nodes[2].url, 'https://a.b');
	assert.equal('text' in doc.nodes[3], false, '空字符串字段不收（省得绘制层再判一次空）');
});

test('parseCanvasDocument 保留 file 节点的 subpath（缩小至标题 / 块），空串同样不落键', () => {
	const doc = parseCanvasDocument(
		JSON.stringify({
			nodes: [
				{ id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'a.md', subpath: '#2. 强调与标记' },
				{ id: 'e', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'b.md', subpath: '' },
			],
		}),
	);
	assert.ok(doc);
	assert.equal(doc.nodes[0].subpath, '#2. 强调与标记', 'subpath 逐字保留（含空格与点）');
	assert.equal('subpath' in doc.nodes[1], false, '空串不收 —— 与 color / file / url / label 同一口径');
});

test('parseCanvasDocument 对坏输入一律返回 null（调用方因此回退纯文本）', () => {
	assert.equal(parseCanvasDocument('不是 JSON'), null, '非 JSON');
	assert.equal(parseCanvasDocument('null'), null, 'JSON null');
	assert.equal(parseCanvasDocument('[]'), null, 'JSON 数组');
	assert.equal(parseCanvasDocument(JSON.stringify({ edges: [] })), null, '没有 nodes');
	assert.equal(parseCanvasDocument(JSON.stringify({ nodes: {} })), null, 'nodes 不是数组');
});

test('parseCanvasDocument 过滤后没有节点 → null（空画布不该弹窗）', () => {
	assert.equal(parseCanvasDocument(JSON.stringify({ nodes: [] })), null, '空数组');
	assert.equal(
		parseCanvasDocument(JSON.stringify({ nodes: [{ id: 'x', type: 'text' }] })),
		null,
		'坐标缺失的节点被丢弃后就没有节点了',
	);
});

test('parseCanvasDocument 逐条丢弃坏节点，好节点照常保留', () => {
	const doc = parseCanvasDocument(
		JSON.stringify({
			nodes: [
				{ id: 'ok', type: 'text', x: 0, y: 0, width: 10, height: 10 },
				{ type: 'text', x: 0, y: 0, width: 10, height: 10 }, // 没 id
				{ id: 'bad-type', type: 'pdf', x: 0, y: 0, width: 10, height: 10 }, // 类型不认识
				{ id: 'bad-size', type: 'text', x: 0, y: 0, width: '10', height: 10 }, // 坐标不是数字
				{ id: 'nan', type: 'text', x: 0, y: 0, width: 10, height: Number.NaN },
				'字符串',
				null,
			],
		}),
	);
	assert.ok(doc);
	assert.deepEqual(doc.nodes.map((node) => node.id), ['ok']);
});

test('parseCanvasDocument 里坏边被丢弃、edges 缺失时当空数组', () => {
	const doc = parseCanvasDocument(
		JSON.stringify({
			nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 }],
			edges: [
				{ id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' },
				{ id: 'e2', fromNode: 'a', fromSide: 'diagonal', toNode: 'b', toSide: 'left' },
				{ id: 'e3', fromNode: 'a', toNode: 'b' },
			],
		}),
	);
	assert.ok(doc);
	assert.deepEqual(doc.edges.map((edge) => edge.id), ['e1'], '方位不合法 / 缺方位的边丢弃');

	const noEdges = parseCanvasDocument(
		JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 }] }),
	);
	assert.deepEqual(noEdges?.edges, [], '没有 edges 键 → 空数组（边画不出来不该丢掉整份快照）');
});

// —— canvasBounds ——

test('canvasBounds 覆盖负坐标：四边各外扩 padding', () => {
	// 样本实测：minX = -360、minY = -140、maxX = 245、maxY = 127
	const doc = parseCanvasDocument(SAMPLE);
	assert.ok(doc);
	assert.deepEqual(canvasBounds(doc.nodes, CANVAS_PADDING), {
		x: -360 - CANVAS_PADDING,
		y: -140 - CANVAS_PADDING,
		width: 605 + CANVAS_PADDING * 2,
		height: 267 + CANVAS_PADDING * 2,
	});
});

test('canvasBounds 的 padding 生效（0 = 紧贴内容）', () => {
	const nodes = [box(10, 20, 30, 40), box(50, 0, 10, 10)];
	assert.deepEqual(canvasBounds(nodes, 0), { x: 10, y: 0, width: 50, height: 60 });
	assert.deepEqual(canvasBounds(nodes, 5), { x: 5, y: -5, width: 60, height: 70 });
});

test('canvasBounds 空数组 → null', () => {
	assert.equal(canvasBounds([], CANVAS_PADDING), null);
});

// —— edgeEndpoints ——

test('edgeEndpoints 取该 side 的中点（四条各一）', () => {
	const node = box(0, 0, 100, 50);
	assert.deepEqual(edgeEndpoints(node, 'left', box(300, 0, 100, 50), 'left'), {
		x1: 0,
		y1: 25,
		x2: 300,
		y2: 25,
	});
	assert.deepEqual(edgeEndpoints(node, 'right', node, 'right'), { x1: 100, y1: 25, x2: 100, y2: 25 });
	assert.deepEqual(edgeEndpoints(node, 'top', node, 'top'), { x1: 50, y1: 0, x2: 50, y2: 0 });
	assert.deepEqual(edgeEndpoints(node, 'bottom', node, 'bottom'), { x1: 50, y1: 50, x2: 50, y2: 50 });
});

test('edgeEndpoints 对 0 宽高的退化盒不抛（返回同一个点）', () => {
	const degenerate = box(10, 20, 0, 0);
	assert.deepEqual(edgeEndpoints(degenerate, 'right', degenerate, 'left'), {
		x1: 10,
		y1: 20,
		x2: 10,
		y2: 20,
	});
});

// —— edgePath ——

test('edgePath 是三次贝塞尔：M 起点 + C 两个控制点 + 终点', () => {
	// 两盒间距 200 → 控制点距离 = clamp(200 × 0.25, 20, 120) = 50
	const d = edgePath(box(0, 0, 100, 50), 'right', box(300, 0, 100, 50), 'left');
	assert.equal(d, 'M 100 25 C 150 25 250 25 300 25');
});

test('edgePath 四种 side 组合都以 M 开头、含 C 段', () => {
	const from = box(0, 0, 100, 50);
	const to = box(300, 200, 100, 50);
	for (const fromSide of ['top', 'right', 'bottom', 'left']) {
		for (const toSide of ['top', 'right', 'bottom', 'left']) {
			const d = edgePath(from, fromSide, to, toSide);
			assert.ok(d?.startsWith('M '), `${fromSide} → ${toSide} 以 M 开头`);
			assert.ok(d?.includes(' C '), `${fromSide} → ${toSide} 含 C 段`);
		}
	}
});

test('edgePath 控制点距离被夹在 [20, 120]（相距很近不退化、很远也不甩出去）', () => {
	// 同一个盒子、右 → 左：两端点相距 100 → 距离 = clamp(25, 20, 120) = 25
	const close = edgePath(box(0, 0, 100, 50), 'right', box(0, 0, 100, 50), 'left');
	assert.equal(close, 'M 100 25 C 125 25 -25 25 0 25');

	// 两端点相距 4990 → 距离 = clamp(1247.5, 20, 120) = 120
	const far = edgePath(box(0, 0, 10, 10), 'right', box(5000, 0, 10, 10), 'left');
	assert.equal(far, 'M 10 5 C 130 5 4880 5 5000 5');

	// 端点重合（同一个节点、同一个 side）：span 0 → 距离落到下限 20，不会退化成一条零长线段
	const samePoint = edgePath(box(0, 0, 100, 50), 'right', box(0, 0, 100, 50), 'right');
	assert.equal(samePoint, 'M 100 25 C 120 25 120 25 100 25');
});

test('edgePath 端点缺失（另一头指向被过滤掉的节点）→ null，由调用方丢弃这条边', () => {
	assert.equal(edgePath(undefined, 'right', box(0, 0, 10, 10), 'left'), null);
	assert.equal(edgePath(box(0, 0, 10, 10), 'right', undefined, 'left'), null);
});

// —— edgeArrowPath ——

test('edgeArrowPath 把 tip 放在终点、底边垂直于末端切线（右 → 左那条实算一遍）', () => {
	// 起点 (100,25) → 终点 (300,25)，末端控制点 (250,25) ⇒ 方向 (1,0)、底边竖直
	assert.equal(
		edgeArrowPath(box(0, 0, 100, 50), 'right', box(300, 0, 100, 50), 'left'),
		'M 300 25 L 290 29.5 L 290 20.5 Z',
	);
});

test('edgeArrowPath 对「同节点同 side」的退化边也画得出箭头（方向取控制点，不是零向量）', () => {
	assert.equal(
		edgeArrowPath(box(0, 0, 100, 50), 'right', box(0, 0, 100, 50), 'right'),
		'M 100 25 L 110 20.5 L 110 29.5 Z',
	);
});

test('edgeArrowPath 端点缺失 → null（调用方跳过箭头，连线本身照画）', () => {
	assert.equal(edgeArrowPath(undefined, 'right', box(0, 0, 10, 10), 'left'), null);
	assert.equal(edgeArrowPath(box(0, 0, 10, 10), 'right', undefined, 'left'), null);
});

// —— canvasEmbedText ——

/** file 节点的最小形态（只带本函数读的两个字段）。 */
function fileNode(file, subpath) {
	return { id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file, subpath };
}

test('canvasEmbedText 把 subpath 拼进 ![[…]]（标题 / 块 / 无 / 非法四种输入）', () => {
	assert.equal(canvasEmbedText(fileNode('a.md', '#2. 强调与标记')), '![[a.md#2. 强调与标记]]', '缩小至标题');
	assert.equal(canvasEmbedText(fileNode('b.md', '#^abc123')), '![[b.md#^abc123]]', '缩小至块');
	assert.equal(canvasEmbedText(fileNode('c.md', undefined)), '![[c.md]]', '没有 subpath = 整篇（对既有画布是恒等操作）');
	assert.equal(canvasEmbedText(fileNode('d.md', '2. 强调')), '![[d.md]]', '非法 subpath（无 #）忽略 → 退回整篇');
});
