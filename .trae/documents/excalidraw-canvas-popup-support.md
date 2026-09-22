# 在 Text Popup 弹窗中支持 Canvas 与 Excalidraw 嵌入

## Context

Text Popup 当前只识别图片扩展名白名单（`bmp/png/jpg/jpeg/gif/svg/webp/avif`）的 `![[xxx]]` 嵌入（[src/blocks.ts#L305](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/blocks.ts#L305)）。Obsidian 原生支持嵌入的 Canvas（`.canvas`）和 Excalidraw 插件支持嵌入的 `.excalidraw` / `.excalidraw.md` 都不在此列表里，扫描器直接忽略。

本期目标：
- **Canvas**：走标准 MarkdownRenderer 嵌入路径（Obsidian 原生支持，渲染为只读 SVG 预览）。
- **Excalidraw**：不在弹窗里加载 Excalidraw 视图本身，而是要求用户开启 Excalidraw 插件的 Auto-export，弹窗显示时改写为同名 PNG/SVG 图片的嵌入语法，交给 MarkdownRenderer 渲染。SVG 优先、PNG 回退、都找不到丢弃候选并告警。
- **Bases**：本期不做任何支持，保留现状（` ```base ` 代码块继续走普通 `code` 路径，行为不保证）。

期望结果：在笔记里写 `![[file.canvas]]` 或 `![[file.excalidraw]]`，点击放大图标能在弹窗里看到对应内容；Excalidraw 用户在 Excalidraw 插件设置里开启 Auto-export SVG + filename sync 后无需额外配置即可使用。

---

## 改动总览

| 文件 | 改动 |
|------|------|
| [src/blocks.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/blocks.ts) | 扩展 `wikiImageTarget` 识别 `.canvas` / `.excalidraw` / `.excalidraw.md` |
| [src/scanner/session.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/scanner/session.ts) | `createCandidate` 新增 Excalidraw 分支：调 `resolveExcalidrawImage` 改写 `rich` |
| [src/extract.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/extract.ts) | 新增 `resolveExcalidrawImage` 工具函数 + Excalidraw 块的纯文本回退 |
| [src/settings.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/settings.ts) | 新增 `excalidrawImageFallback: boolean` 与 `excalidrawPreferredFormat: 'svg'\|'png'` |
| [src/lang/locale/en.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/lang/locale/en.ts) | 新增设置项标签（key = value，sentence case） |
| [src/lang/locale/zh-cn.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/lang/locale/zh-cn.ts) | 对应中文翻译 |
| [src/lang/locale/zh-tw.ts](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/lang/locale/zh-tw.ts) | 对应繁中翻译 |
| tests/*.test.mjs | 新增/扩展：blocks 识别新扩展名、`resolveExcalidrawImage` 优先级逻辑、settings 归一化 |

---

## 详细改动

### 1. blocks.ts：扩展识别范围

**位置**：[src/blocks.ts#L316-L340](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/blocks.ts#L316-L340)

**保留** `IMAGE_EXTENSIONS` 与 `hasImageExtension` 不变（它们专门服务于真正的图片扩展名）。

**新增**：在 `hasImageExtension` 之后新增一个判断函数：

```ts
const EMBEDDABLE_NON_IMAGE_EXTENSIONS = ['canvas'];
const EMBEDDABLE_NON_IMAGE_SUFFIXES = ['.excalidraw', '.excalidraw.md'];

/** wiki embed 的 target 是否是「Canvas / Excalidraw」可放大文件 */
function hasEmbeddableNonImageExtension(target: string): boolean {
  const lower = target.toLowerCase();
  if (EMBEDDABLE_NON_IMAGE_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  const dot = target.lastIndexOf('.');
  return dot > 0 && EMBEDDABLE_NON_IMAGE_EXTENSIONS.includes(target.slice(dot + 1).toLowerCase());
}
```

**修改** `wikiImageTarget`：把 `hasImageExtension(target)` 改为 `hasImageExtension(target) || hasEmbeddableNonImageExtension(target)`。`pathImageTarget`（标准 markdown 图片语法）保持不变 — Canvas/Excalidraw 不走 `![](...)` 写法，只走 wiki embed。

**注释更新**：`IMAGE_EXTENSIONS` 上方注释「Live Preview 里会被核心建成『图片嵌入』的扩展名」保持原样，并补充：Canvas / Excalidraw 走 `hasEmbeddableNonImageExtension`，因为它们不是图片扩展名但 Live Preview 一样建 `.image-embed`。

### 2. extract.ts：新增 `resolveExcalidrawImage` 与纯文本回退

**位置**：[src/extract.ts#L93-L109](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/extract.ts#L93-L109)（紧接 `extractImageBody`）

**新增函数**：

```ts
import type { App, TFile } from 'obsidian';

/**
 * 解析 Excalidraw wiki embed 的同名 PNG/SVG 文件。
 *
 * Excalidraw 插件 Auto-export + filename sync 开启后，绘图 `xxx.excalidraw` 或
 * `xxx.excalidraw.md` 会同目录生成 `xxx.excalidraw.svg` 与/或 `xxx.excalidraw.png`。
 * 我们按设置里的优先格式先找一种、找不到再找另一种，都不存在则返回 null（候选丢弃）。
 *
 * 返回的是 wiki link 形态的路径（用于构造 `![[<path>]]` 喂给 MarkdownRenderer），
 * 用 `file.path` 而不是 basename，避免歧义。
 */
export function resolveExcalidrawImage(
  app: App,
  rawEmbed: string,
  sourcePath: string,
  preferredFormat: 'svg' | 'png',
): string | null {
  const wiki = WIKI_EMBED.exec(rawEmbed);
  if (!wiki) return null;
  const inner = wiki[1] ?? '';
  const target = inner.split('|')[0]?.split('#')[0]?.trim() ?? '';
  // 把 .excalidraw 或 .excalidraw.md 后缀整个去掉，得到 base 名
  const base = target.replace(/\.excalidraw(\.md)?$/i, '');
  if (!base) return null;

  const fallbackFormat = preferredFormat === 'svg' ? 'png' : 'svg';
  const candidates = [
    `${base}.excalidraw.${preferredFormat}`,
    `${base}.excalidraw.${fallbackFormat}`,
  ];

  for (const candidate of candidates) {
    const file = app.metadataCache.getFirstLinkpath(candidate, sourcePath);
    if (file instanceof TFile) return file.path;
  }
  return null;
}

/**
 * 判断一段 wiki embed 是否是 Excalidraw 嵌入（用于 createCandidate 分流）。
 */
export function isExcalidrawEmbed(rawEmbed: string): boolean {
  const wiki = WIKI_EMBED.exec(rawEmbed);
  if (!wiki) return false;
  const target = (wiki[1] ?? '').split('|')[0]?.split('#')[0]?.trim() ?? '';
  return /\.excalidraw(\.md)?$/i.test(target);
}
```

**修改** `extractImageBody`：Excalidraw 块的纯文本回退走原有路径已经够用 — 它会取 `[[file.excalidraw]]` 的第一段作为文件名返回（如 `file.excalidraw`），表示「这是 Excalidraw 绘图」。无需改动。

### 3. scanner/session.ts：createCandidate 新增 Excalidraw 分支

**位置**：[src/scanner/session.ts#L209-L241](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/scanner/session.ts#L209-L241) 的 `createCandidate`

**改动**：在 `region.kind === 'html'` 分支之后、`const plain = readTextBody(region)` 之前，新增 Excalidraw 分支：

```ts
import { isExcalidrawEmbed, resolveExcalidrawImage } from '../extract';

function createCandidate(region, host, measure): PopupCandidate | null {
  if (region.kind === 'html') { /* 原逻辑不变 */ }

  // Excalidraw wiki embed：找到同名 PNG/SVG 则改写 rich，找不到则丢弃候选
  if (region.kind === 'image' && isExcalidrawEmbed(region.raw)) {
    if (!host.settings.excalidrawImageFallback) return null;
    // sourcePath 由 buildPopupSession 在闭包外传入（见下方）
    const resolved = resolveExcalidrawImage(
      host.app,
      region.raw,
      sourcePath,
      host.settings.excalidrawPreferredFormat,
    );
    if (!resolved) {
      console.warn(
        `[text-popup] Excalidraw 同名图片未找到，请确认 Auto-export 已开启并保持文件名同步：${region.raw}`,
      );
      return null;
    }
    const plain = extractImageBody(region.raw);
    return {
      region,
      read: () => ({
        plain,
        rich: `![[${resolved}]]`,
      }),
    };
  }

  // 其余六类（含 Canvas 嵌入走 image 路径）按原逻辑
  const plain = readTextBody(region);
  if (!plain) return null;
  return { /* 原逻辑不变 */ };
}
```

**sourcePath 注入**：`createCandidate` 当前不接收 sourcePath。需要把 `file?.path ?? ''` 从 `buildPopupSession` 传进来。改 `createCandidate` 的签名增加 `sourcePath: string` 参数，调用处（`buildPopupSession` 的循环里）传入。Canvas 走 image 通用分支不需要 sourcePath，传了不影响。

### 4. settings.ts：新增两个设置项

**位置**：[src/settings.ts#L15-L34](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/settings.ts#L15-L34)（`TextPopupSettings` 接口）

新增字段：
```ts
/** 是否对 Excalidraw 嵌入走「同名 PNG/SVG 图片回退」路径（要求 Excalidraw 插件开启 Auto-export）。 */
excalidrawImageFallback: boolean;
/** Excalidraw 同名图片的优先格式：SVG 矢量（推荐），PNG 回退。 */
excalidrawPreferredFormat: 'svg' | 'png';
```

**DEFAULT_SETTINGS**（L41-L51）新增：
```ts
excalidrawImageFallback: false,  // 默认关 — 强制用户主动启用并确认 Auto-export 已开
excalidrawPreferredFormat: 'svg',
```

**normalizeSettings**（L122-L145）新增两个字段的归一化：
```ts
excalidrawImageFallback:
  typeof data.excalidrawImageFallback === 'boolean'
    ? data.excalidrawImageFallback
    : DEFAULT_SETTINGS.excalidrawImageFallback,
excalidrawPreferredFormat:
  data.excalidrawPreferredFormat === 'png' ? 'png' : 'svg',
```

**SettingKey 联合类型**（L155-L171）新增：
```ts
| 'excalidrawImageFallback'
| 'excalidrawPreferredFormat'
```

**readSettingValue / writeSettingValue / settingSideEffects** 三个函数新增对应 case：
- `settingSideEffects`：两个键都返回 `NO_EFFECTS`（不触发刷新，纯保存即可）
- `readSettingValue`：直接返回 `settings[key]`
- `writeSettingValue`：
  - `excalidrawImageFallback`: `return assign(settings, 'excalidrawImageFallback', value === true);`
  - `excalidrawPreferredFormat`: `return assign(settings, 'excalidrawPreferredFormat', value === 'png' ? 'png' : 'svg');`

**getSettingDefinitions**（L376-L512）：在「Popup content」分组里追加两项（放在 `renderRichText` 之后、`popupBackgroundFollowTheme` 之前）：

```ts
{
  name: t('Excalidraw image fallback'),
  desc: t(
    'Show Excalidraw embeds as same-name PNG/SVG images inside the popup. Requires Auto-export SVG and filename sync enabled in the Excalidraw plugin.',
  ),
  control: { type: 'toggle', key: 'excalidrawImageFallback' },
},
{
  name: t('Preferred Excalidraw image format'),
  desc: t(
    'SVG is vector and scales losslessly with the popup zoom; PNG is raster. The fallback format is tried if the preferred one is missing.',
  ),
  visible: () => settings.excalidrawImageFallback,
  control: {
    type: 'dropdown',
    key: 'excalidrawPreferredFormat',
    options: { svg: 'SVG', png: 'PNG' },
  },
},
```

第二项的 `visible` 让默认格式选择仅在用户启用 fallback 后才出现，与「跟随主题」色块的可见性切换同模式。

### 5. i18n 字典

**en.ts** 新增键（key = value，sentence case）：
- `'Excalidraw image fallback'`
- `'Show Excalidraw embeds as same-name PNG/SVG images inside the popup. Requires Auto-export SVG and filename sync enabled in the Excalidraw plugin.'`
- `'Preferred Excalidraw image format'`
- `'SVG is vector and scales losslessly with the popup zoom; PNG is raster. The fallback format is tried if the preferred one is missing.'`

**zh-cn.ts** / **zh-tw.ts** 同步补对应翻译。

### 6. modal.ts 的 mermaidObserver（不强制改）

Canvas 嵌入是异步加载 SVG，当前 [modal.ts#L660-L678](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/src/modal.ts#L660-L678) 的 `fitMermaid` 只对 `.mermaid > svg` 起作用，Canvas 的 SVG 不在此 selector 内。

**本期决策**：不主动给 Canvas 加 fit 逻辑。Canvas 嵌入默认按 Obsidian 自己的尺寸渲染，弹窗里若过大/过小用户可手动用底部「字号 / 缩放」控件调整。如真机测试发现体验严重不佳，后续单开一个改动加 `canvas-embed svg` 到 observer selector 与 fit 函数的分支。

### 7. Bases

不做任何特殊处理。` ```base ` 代码块仍按现有 `code` 类别识别，`region.raw` 整段喂给 MarkdownRenderer，Bases 插件的 post-processor 若能渲染就渲染，否则显示原码。这是「显式不保证」路径，文档与设置项里都不提及 Bases。

---

## 关键设计决策

1. **Excalidraw 默认关 (`excalidrawImageFallback: false`)**：避免在用户没开 Auto-export 时悄悄丢弃候选。默认关 + 设置项文案明确写前置条件，让用户主动启用并预先检查 Excalidraw 设置。
2. **归入 `image` 类别而非新增 `excalidraw` BlockKind**：Excalidraw 本质上是「图片回退」，复用 `blockKinds.image` 开关（默认开）。不污染 `BlockKindSettings` 接口。
3. **`resolveExcalidrawImage` 返回 file.path 而不是 basename**：避免歧义（同名文件在 vault 不同目录）。MarkdownRenderer 用 `![[path]]` 形式能稳定解析。
4. **`.excalidraw.md` 双层扩展名用 `endsWith` 判断而非 `hasImageExtension`**：`hasImageExtension` 用 `lastIndexOf('.')` 只能取到最后一段，对 `.excalidraw.md` 取的是 `md`，命中不了。新写的 `hasEmbeddableNonImageExtension` 用 `endsWith` 处理这一特例。
5. **不做自定义导出目录支持**：第一版要求用户的 Excalidraw Auto-export 目录与绘图同目录（这是 Excalidraw 插件默认行为）。设置项文案里写明前置条件。后续若有反馈再加 `excalidrawExportFolder` 字段。

---

## 验证

### 单元测试

在 [tests/extract.test.mjs](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/tests/extract.test.mjs)（若不存在则新建）新增：

```js
test('isExcalidrawEmbed: 识别 .excalidraw 与 .excalidraw.md 两种写法', () => {
  assert.ok(isExcalidrawEmbed('![[file.excalidraw]]'));
  assert.ok(isExcalidrawEmbed('![[file.excalidraw.md]]'));
  assert.ok(isExcalidrawEmbed('![[folder/file.excalidraw|100]]'));
  assert.ok(!isExcalidrawEmbed('![[file.png]]'));
  assert.ok(!isExcalidrawEmbed('![[file.canvas]]'));
});

test('resolveExcalidrawImage: SVG 优先、PNG 回退、都找不到返回 null', () => {
  const fakeApp = {
    metadataCache: {
      getFirstLinkpath: (linkpath) => {
        if (linkpath === 'file.excalidraw.svg') return { path: 'file.excalidraw.svg' };
        if (linkpath === 'file2.excalidraw.png') return { path: 'file2.excalidraw.png' };
        return null;
      },
    },
  };
  assert.equal(resolveExcalidrawImage(fakeApp, '![[file.excalidraw]]', '', 'svg'), 'file.excalidraw.svg');
  assert.equal(resolveExcalidrawImage(fakeApp, '![[file2.excalidraw]]', '', 'svg'), 'file2.excalidraw.png');
  assert.equal(resolveExcalidrawImage(fakeApp, '![[file3.excalidraw]]', '', 'svg'), null);
  assert.equal(resolveExcalidrawImage(fakeApp, '![[file.excalidraw.md]]', '', 'svg'), 'file.excalidraw.svg');
});
```

在 [tests/blocks.test.mjs](file:///Users/johnny/Documents/Sync/IOTO-Plugins/.obsidian/plugins/text-popup/tests/blocks.test.mjs) 扩展：

```js
test('matchImageBlock: 识别 .canvas / .excalidraw / .excalidraw.md 为 image 块', () => {
  // 复用现有 matchImageBlock 调用模式
  assertImageBlock('![[file.canvas]]');
  assertImageBlock('![[file.excalidraw]]');
  assertImageBlock('![[file.excalidraw.md]]');
  assertNoImageBlock('![[file.base]]');  // Bases 不在白名单
});
```

### 集成测试（手动）

1. `npm run lint` 与 `npm test` 全过；
2. `npm run dev` 构建后，在测试 vault 中：
   - 笔记里写 `![[some-canvas.canvas]]`，确认放大图标出现，点击后弹窗内显示 Canvas 只读 SVG 预览；
   - 笔记里写 `![[some.excalidraw]]`（用户已在 Excalidraw 插件设置里开启 Auto-export SVG + filename sync），设置里打开「Excalidraw image fallback」，点击放大图标后弹窗内显示同名 SVG 图片；
   - 关闭 Excalidraw 设置里的 Auto-export，删除同名 SVG/PNG，点击放大图标 — 弹窗不应打开，控制台输出 `[text-popup] Excalidraw 同名图片未找到...` 警告；
   - 把优先格式切到 PNG，确认弹窗里改用 PNG；
   - 在 Excalidraw 插件设置里关掉 filename sync（不同名），重新点击 — 弹窗不开 + 警告。
3. `npm run build` 产物在插件根目录的 `main.js`，按 `AGENTS.md` 路径手动复制到测试 vault 验证。

### 兼容性

- `minAppVersion` 不需要升 — 只用到公开 `metadataCache.getFirstLinkpath` 与 `MarkdownRenderer.render`；
- 老 `data.json` 没有新字段时由 `normalizeSettings` 自动补默认值，不需迁移脚本。
