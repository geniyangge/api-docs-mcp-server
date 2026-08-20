#!/usr/bin/env node
/**
 * 发版脚本：更新版本号 → npm publish（构建/测试由 prepublishOnly 兜底）→ 交给 postpublish 钩子提交与推送。
 *
 * 用法：
 *   npm run release                  # 默认 patch（0.0.1 -> 0.0.2）
 *   npm run release -- --version=minor   # 次版本（0.0.1 -> 0.1.0）
 *   npm run release -- --version=major   # 主版本（0.0.1 -> 1.0.0）
 *
 * 流程：
 *   1) 解析 --version（patch/minor/major，默认 patch），校验分支与工作区
 *   2) 更新 package.json 与 package-lock.json 的 version
 *   3) npm publish —— prepublishOnly 会自动执行 build + test 保护；
 *      publish 成功后的 git commit / tag / push 由 postpublish 钩子（__sh/git-push.cjs）完成
 *
 * 环境变量（见 .env.example）：
 *   GIT_RELEASE_BRANCH   允许发布的分支（可选，默认 master）
 *   RELEASE_DRY_RUN      任意非空值 = 演练模式（仅打印，不落任何改动）
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- 常量

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

const DRY_RUN = Boolean(process.env.RELEASE_DRY_RUN);
const VERSION_TYPES = ['patch', 'minor', 'major'];

/** 带 2 空格缩进并追加换行写出 JSON（与 npm 写入格式保持一致） */
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');

// ---------------------------------------------------------------- 通用工具

/** 打印错误并退出进程 */
function fail(msg) {
	console.error(`[release] ${msg}`);
	process.exit(1);
}

/** 从 execFileSync 的异常中提取可读的错误信息 */
function describeError(err) {
	return (err.stderr || err.message).toString().trim();
}

/** 只读 git 查询（dry-run 下也会真实执行，保证校验有效） */
function gitRead(args) {
	try {
		return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
	} catch (err) {
		fail(`git ${args.join(' ')} 失败: ${describeError(err)}`);
	}
}

/** 执行外部命令（dry-run 下仅打印，不真正执行） */
function run(command, args) {
	if (DRY_RUN) {
		console.log(`[release][dry-run] 将执行: ${command} ${args.join(' ')}`);
		return;
	}
	try {
		execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
	} catch (err) {
		fail(`${command} ${args.join(' ')} 失败: ${describeError(err)}`);
	}
}

// ---------------------------------------------------------------- 环境变量

/**
 * 加载环境变量文件。
 * - 文件由 ENV_FILE 指定，默认项目根 .env；文件不存在时静默跳过
 * - 不覆盖已存在的环境变量（shell 已设置的优先级高于 .env）
 * - 优先 Node 原生 process.loadEnvFile（>= 21.7），老版本降级手动解析
 */
function loadEnvFile() {
	const file = process.env.ENV_FILE || '.env';
	const abs = path.resolve(ROOT, file);
	if (typeof process.loadEnvFile === 'function') {
		try {
			process.loadEnvFile(abs);
			return;
		} catch (err) {
			if (err.code === 'ENOENT') return;
			fail(`加载 ${file} 失败: ${err.message}`);
		}
	}
	if (!fs.existsSync(abs)) return;
	for (const line of fs.readFileSync(abs, 'utf-8').split(/\r?\n/)) {
		const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trim().startsWith('#')) continue;
		let value = m[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[m[1]] === undefined) process.env[m[1]] = value;
	}
}

// ---------------------------------------------------------------- 参数与前置校验

/** 解析 --version=xxx（默认 patch），非法值直接退出 */
function parseVersionType() {
	const flag = process.argv.slice(2).find(a => a.startsWith('--version='));
	const type = (flag ? flag.split('=')[1] : 'patch') || 'patch';
	if (!VERSION_TYPES.includes(type)) {
		fail(`--version 仅支持 ${VERSION_TYPES.join(' / ')}，收到: ${type}`);
	}
	return type;
}

/**
 * 发布前置校验：分支必须为 GIT_RELEASE_BRANCH（默认 master），且工作区干净。
 * 返回当前分支名（用于日志展示）。
 */
function assertReleaseReady() {
	const allowBranch = process.env.GIT_RELEASE_BRANCH || 'master';
	const branch = gitRead(['branch', '--show-current']);
	if (branch !== allowBranch) {
		fail(`发版仅允许在 ${allowBranch} 分支执行（当前: ${branch || '(detached)'}）`);
	}
	const dirty = gitRead(['status', '--porcelain']);
	if (dirty) {
		fail(`工作区有未提交改动，请先提交并推送：\n${dirty}`);
	}
	return branch;
}

// ---------------------------------------------------------------- 版本管理

/** 读取 package.json 并校验 version 为 x.y.z 格式 */
function readPackageJson() {
	const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
		fail(`无法解析版本号: ${pkg.version}`);
	}
	return pkg;
}

/** 按发版类型计算下一个版本号（type 已由 parseVersionType 校验） */
function computeNextVersion(type, current) {
	const [maj, min, pat] = current.split('.').map(Number);
	switch (type) {
		case 'minor':
			return `${maj}.${min + 1}.0`;
		case 'major':
			return `${maj + 1}.0.0`;
		default: // patch
			return `${maj}.${min}.${pat + 1}`;
	}
}

/** 把新版本号写入 package.json 与 package-lock.json（lock 存在且含 version 字段时才更新） */
function updateVersionFiles(pkg, next) {
	pkg.version = next;
	writeJson(PKG_PATH, pkg);

	if (fs.existsSync(LOCK_PATH)) {
		const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
		if (lock.version) {
			lock.version = next;
			writeJson(LOCK_PATH, lock);
		}
	}
}

// ---------------------------------------------------------------- 主流程

function main() {
	// 1. 加载环境变量（ENV_FILE 指定文件，默认 .env）
	loadEnvFile();

	// 2. 解析发版类型，校验分支与工作区
	const type = parseVersionType();
	const branch = assertReleaseReady();

	// 3. 计算新版本并写入 package.json / package-lock.json
	const pkg = readPackageJson();
	const next = computeNextVersion(type, pkg.version);
	console.log(`[release] ${type} ${pkg.version} -> ${next}（分支 ${branch}）`);
	updateVersionFiles(pkg, next);

	// 4. npm publish（prepublishOnly 自动执行 build + test）
	run('npm', ['publish']);

	console.log(`[release] v${next} 已发布，postpublish 钩子将自动提交版本变更、打 tag 并推送。`);
}

main();