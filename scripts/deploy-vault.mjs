#!/usr/bin/env node
/**
 * 把构建产物一键复制到本地 Obsidian 库的插件目录（默认 IOTO 主库）。
 *
 * 用法（在插件目录下执行）：
 *   npm run build:local                       # 构建 + 复制到默认库（库名 IOTO）
 *   npm run build:local -- --vault <库名>      # 按库名部署，如 --vault MyIOTO
 *   npm run build:local -- --vault <路径>      # 按完整路径部署，如 --vault D:/Users/johnn/Documents/IOTO
 *   node scripts/deploy-vault.mjs --list      # 列出本机所有可用的库
 *   node scripts/deploy-vault.mjs             # 只复制（复用已有构建产物，不重新构建）
 *
 * 约定：
 *   - 库名 → 路径通过 Obsidian 全局库注册表 obsidian.json 解析（只读），因此跨平台、跨盘符都成立。
 *   - 插件目录名取自 manifest.json 的 id，不使用 package.json 的 name。
 *   - 只覆盖 main.js / manifest.json / styles.css，库里的 data.json 等用户数据不会被碰。
 *   - 本脚本不改版本号、不打包、不提交 git，纯粹是「构建产物 → 库」的搬运。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = ['main.js', 'manifest.json', 'styles.css'];
const DEFAULT_VAULT_NAME = 'IOTO';

const c = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
};

const log = {
	step: (m) => console.log(`\n${c.cyan}${c.bold}▶ ${m}${c.reset}`),
	info: (m) => console.log(`  ${m}`),
	ok: (m) => console.log(`  ${c.green}✓${c.reset} ${m}`),
	warn: (m) => console.log(`  ${c.yellow}!${c.reset} ${m}`),
	err: (m) => console.error(`  ${c.red}✗${c.reset} ${m}`),
};

function parseArgs(argv) {
	const opts = { vault: null, list: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--vault') opts.vault = argv[++i];
		else if (a.startsWith('--vault=')) opts.vault = a.slice('--vault='.length);
		else if (a === '--list') opts.list = true;
		else if (a === '--help' || a === '-h') opts.help = true;
		else throw new Error(`未知参数: ${a}（可用 --help 查看用法）`);
	}
	return opts;
}

function printHelp() {
	console.log(`部署构建产物到本地 Obsidian 库

用法:
  npm run build:local                      构建并复制到默认库（库名 ${DEFAULT_VAULT_NAME}）
  npm run build:local -- --vault <库名>     构建并复制到指定库（如 MyIOTO）
  npm run build:local -- --vault <路径>     构建并复制到指定库（库根目录）
  node scripts/deploy-vault.mjs [同上]      只复制，不重新构建

选项:
  --vault <库名|路径>  目标库；传库名时从 Obsidian 库注册表解析路径
                       （默认库名 ${DEFAULT_VAULT_NAME}）
  --list              列出本机所有可用的库（名称 / 路径）
  -h, --help          显示本帮助
`);
}

/** 含分隔符 / 盘符 / ~ / 绝对路径 → 视为路径；否则视为库名。 */
function isPathLike(v) {
	return v.startsWith('~') || /^[A-Za-z]:/.test(v) || /[\\/]/.test(v) || path.isAbsolute(v);
}

/** 展开 ~ 开头的路径，并解析为绝对路径。 */
function resolveVaultPath(p) {
	const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
	return path.resolve(expanded);
}

/** 各平台下 Obsidian 全局库注册表 obsidian.json 的位置。 */
function registryPath() {
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'obsidian', 'obsidian.json');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
	}
	const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	return path.join(configHome, 'obsidian', 'obsidian.json');
}

/**
 * 读取库注册表。只读，绝不写回。
 * 文件缺失或解析失败都退化为空表——库名模式随之走 ~/Documents/<name> 兜底。
 * 用 .obsidian 存在性过滤掉已移动/已删除的库。
 */
function readVaultRegistry() {
	const file = registryPath();
	if (!existsSync(file)) return { file, vaults: [] };
	try {
		const json = JSON.parse(readFileSync(file, 'utf8'));
		const vaults = Object.values(json.vaults ?? {})
			.map((v) =>
				v && typeof v.path === 'string'
					? { name: path.basename(path.resolve(v.path)), path: path.resolve(v.path), open: !!v.open }
					: null
			)
			.filter((v) => v && existsSync(path.join(v.path, '.obsidian')));
		return { file, vaults };
	} catch (err) {
		log.warn(`库注册表解析失败，回退到路径推断：${file}（${err.message}）`);
		return { file, vaults: [] };
	}
}

/** 把库列表格式化为「名称 → 路径」多行文本，供报错与 --list 复用。 */
function formatVaults(vaults) {
	if (vaults.length === 0) return '    （注册表中没有可用库）';
	return vaults
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((v) => `    ${v.name} → ${v.path}${v.open ? ` ${c.dim}(已打开)${c.reset}` : ''}`)
		.join('\n');
}

/**
 * 按库名解析库根目录。
 * 顺序：注册表目录名全等匹配（大小写不敏感）→ ~/Documents/<name> 兜底 → 报错。
 */
function resolveVaultByName(name) {
	const { file, vaults } = readVaultRegistry();
	const hits = vaults.filter((v) => v.name.toLowerCase() === name.toLowerCase());

	if (hits.length === 1) return { path: hits[0].path, name: hits[0].name, source: 'registry' };
	if (hits.length > 1) {
		throw new Error(
			`库名 ${name} 匹配到多个库，请改用完整路径（--vault <路径>）：\n` +
				hits.map((v) => `    ${v.name} → ${v.path}`).join('\n')
		);
	}

	const fallback = path.join(os.homedir(), 'Documents', name);
	if (existsSync(path.join(fallback, '.obsidian'))) {
		return { path: fallback, name, source: 'fallback' };
	}

	throw new Error(
		`未找到名为 ${name} 的库。\n` +
			`  可用的库名：\n${formatVaults(vaults)}\n` +
			`  也可以直接用完整路径：--vault <路径>\n` +
			`  注册表：${file}`
	);
}

function kb(bytes) {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function listVaults() {
	const { file, vaults } = readVaultRegistry();
	log.step('本机可用的库');
	if (vaults.length === 0) log.warn(`注册表中没有可用库：${file}`);
	else console.log(formatVaults(vaults));
	log.info(`${c.dim}注册表：${file}${c.reset}`);
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		return;
	}
	if (opts.list) {
		listVaults();
		return;
	}

	log.step('解析目标库');
	const arg = opts.vault || DEFAULT_VAULT_NAME;
	let vault;
	if (isPathLike(arg)) {
		vault = { path: resolveVaultPath(arg), name: path.basename(resolveVaultPath(arg)), source: 'path' };
	} else {
		vault = resolveVaultByName(arg);
	}
	if (!existsSync(path.join(vault.path, '.obsidian'))) {
		throw new Error(
			`目标路径不像是 Obsidian 库（缺少 .obsidian 目录）：${vault.path}\n` +
				`    请用 --vault <库名|路径> 指定正确的库，或执行 --list 查看可用库`
		);
	}
	log.ok(`库 ${vault.name} → ${vault.path} ${c.dim}(${vault.source === 'path' ? '路径模式' : '库名模式'})${c.reset}`);

	const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
	const targetDir = path.join(vault.path, '.obsidian', 'plugins', manifest.id);
	log.ok(`插件 ${manifest.id} v${manifest.version}`);
	log.info(`→ ${targetDir}`);

	log.step('校验构建产物');
	for (const f of ASSETS) {
		if (!existsSync(path.join(ROOT, f))) {
			throw new Error(`构建产物缺失: ${f}（先执行 npm run build）`);
		}
	}
	log.ok(`${ASSETS.length} 个产物齐全`);

	log.step('复制到库');
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
		log.warn(`目标目录不存在，已创建: ${targetDir}`);
	}
	for (const f of ASSETS) {
		const src = path.join(ROOT, f);
		const dest = path.join(targetDir, f);
		if (src === dest) {
			log.warn(`${f} 源与目标为同一文件，已跳过`);
			continue;
		}
		const before = existsSync(dest) ? statSync(dest) : null;
		copyFileSync(src, dest);
		const after = statSync(dest);
		const delta =
			before && before.size !== after.size
				? `${c.dim}(${kb(before.size)} → ${kb(after.size)})${c.reset}`
				: `${c.dim}(${kb(after.size)})${c.reset}`;
		log.ok(`${f} ${delta}`);
	}

	log.step('完成');
	log.info(`若 Obsidian 已打开该库，请重载插件或执行「重新加载应用」后再测试。`);
}

try {
	main();
} catch (err) {
	log.err(err.message || String(err));
	process.exit(1);
}
