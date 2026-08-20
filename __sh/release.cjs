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

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const DRY_RUN = Boolean(process.env.RELEASE_DRY_RUN);

function fail(msg) {
	console.error(`[release] ${msg}`);
	process.exit(1);
}

/** 只读 git 查询（dry-run 下也会真实执行） */
function gitRead(args) {
	try {
		return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
	} catch (err) {
		fail(`git ${args.join(' ')} 失败: ${(err.stderr || err.message).toString().trim()}`);
	}
}

/** 执行外部命令（publish） */
function run(tool, args) {
	if (DRY_RUN) {
		console.log(`[release][dry-run] 将执行: ${tool} ${args.join(' ')}`);
		return;
	}
	try {
		execFileSync(tool, args, { cwd: root, stdio: 'inherit' });
	} catch (err) {
		fail(`${tool} ${args.join(' ')} 失败: ${(err.stderr || err.message).toString().trim()}`);
	}
}

// ---------- 1. 参数与前置校验 ----------

const versionFlag = process.argv.slice(2).find(a => a.startsWith('--version='));
const type = (versionFlag ? versionFlag.split('=')[1] : 'patch') || 'patch';
if (!['patch', 'minor', 'major'].includes(type)) {
	fail(`--version 仅支持 patch / minor / major，收到: ${type}`);
}

const allowBranch = process.env.GIT_RELEASE_BRANCH || 'master';
const branch = gitRead(['branch', '--show-current']);
if (branch !== allowBranch) {
	fail(`发版仅允许在 ${allowBranch} 分支执行（当前: ${branch || '(detached)'}）`);
}

const dirty = gitRead(['status', '--porcelain']);
if (dirty) {
	fail(`工作区有未提交改动，请先提交并推送：\n${dirty}`);
}

// ---------- 2. 计算新版本并写入 ----------

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
	fail(`无法解析版本号: ${pkg.version}`);
}
const [maj, min, pat] = pkg.version.split('.').map(Number);
const next =
	type === 'patch'
		? `${maj}.${min}.${pat + 1}`
		: type === 'minor'
			? `${maj}.${min + 1}.0`
			: `${maj + 1}.0.0`;

console.log(`[release] ${type} ${pkg.version} -> ${next}（分支 ${branch}）`);

const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
pkg.version = next;
writeJson(pkgPath, pkg);

if (fs.existsSync(lockPath)) {
	const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
	if (lock.version) {
		lock.version = next;
		writeJson(lockPath, lock);
	}
}

// ---------- 3. publish（prepublishOnly 自动执行 build + test） ----------

run('npm', ['publish']);

console.log(`[release] v${next} 已发布，postpublish 钩子将自动提交版本变更、打 tag 并推送。`);