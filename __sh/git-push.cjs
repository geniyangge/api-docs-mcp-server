#!/usr/bin/env node
/**
 * postpublish 钩子：npm publish 发布成功后执行的 git 记录与推送。
 *
 * 为什么安全：npm 的 lifecyle 严格顺序执行（prepublishOnly → prepack → 上传 → postpublish），
 * 发布失败会以非零状态退出，postpublish 不会运行——因此本脚本只在包成功发布后触发。
 *
 * 功能：
 *   1) 读取 package.json 当前 version 作为 tag 依据
 *   2) package.json / lock 无版本变更时跳过（覆盖「直接 npm publish 未走 release 脚本」的场景）
 *   3) git commit 版本变更（chore: 版本号升级至 x.y.z）
 *   4) 打 annotated tag v<version>
 *   5) push 源码提交与 tag
 *
 * 环境变量（见 .env.example，均不入库；身份用 -c 注入，不写任何 git config）：
 *   GIT_USER_NAME        提交用户名（必需）
 *   GIT_USER_EMAIL       提交邮箱（必需）
 *   GIT_REMOTE_NAME      远程名（可选，默认 origin）
 *   GIT_REMOTE_URL       远程地址（可选，缺省使用仓库已有 remote）
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
	console.error(`[git-push] ${msg}`);
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

/**
 * 加载环境变量文件。
 * - 文件由 ENV_FILE 指定，默认项目根 .env；文件不存在时静默跳过
 * - 不覆盖已存在的环境变量（shell 已设置的优先级高于 .env）
 * - 优先 Node 原生 process.loadEnvFile（>= 21.7），老版本降级手动解析
 */
function loadEnvFile() {
	const file = process.env.ENV_FILE || '.env';
	const abs = path.resolve(root, file);
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

/** 执行 git 写操作（注入身份，不写 git config） */
function runGit(args) {
	if (DRY_RUN) {
		console.log(`[git-push][dry-run] 将执行: git ${args.join(' ')}`);
		return;
	}
	const identity = [
		'-c',
		`user.name=${process.env.GIT_USER_NAME}`,
		'-c',
		`user.email=${process.env.GIT_USER_EMAIL}`,
	];
	try {
		execFileSync('git', [...identity, ...args], { cwd: root, stdio: 'inherit' });
	} catch (err) {
		fail(`git ${args.join(' ')} 失败: ${(err.stderr || err.message).toString().trim()}`);
	}
}

// ---------- 0. 加载环境变量（ENV_FILE 指定文件，默认 .env） ----------

loadEnvFile();

// ---------- 1. 无版本变更时跳过 ----------

const changed = gitRead(['status', '--porcelain', '--', 'package.json', 'package-lock.json']);
if (!changed) {
	console.warn('[git-push] package.json 无版本变更（直接 npm publish 未走 release 脚本？），跳过 commit/tag/push');
	process.exit(0);
}

// ---------- 2. 校验身份与版本号 ----------

const userName = process.env.GIT_USER_NAME;
const userEmail = process.env.GIT_USER_EMAIL;
if (!userName || !userEmail) {
	fail('缺少 GIT_USER_NAME / GIT_USER_EMAIL，请参考 .env.example 配置');
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
	fail(`无法解析版本号: ${pkg.version}`);
}
const version = pkg.version;
console.log(`[git-push] 记录并推送 v${version}`);

// ---------- 3. commit + tag ----------

runGit(['add', 'package.json', 'package-lock.json']);
runGit(['commit', '-m', `chore: 版本号升级至 ${version}`]);
runGit(['tag', '-a', `v${version}`, '-m', `release v${version}`]);

// ---------- 4. push（源码 + tag） ----------

const remoteName = process.env.GIT_REMOTE_NAME || 'origin';
const remoteUrl = process.env.GIT_REMOTE_URL;
const existingRemotes = gitRead(['remote'])
	.split(/\r?\n/)
	.filter(Boolean);

if (remoteUrl) {
	if (existingRemotes.includes(remoteName)) {
		runGit(['remote', 'set-url', remoteName, remoteUrl]);
	} else {
		runGit(['remote', 'add', remoteName, remoteUrl]);
	}
} else if (!existingRemotes.includes(remoteName)) {
	fail(`远程 ${remoteName} 不存在，请配置 GIT_REMOTE_URL 或先 git remote add ${remoteName}`);
}

runGit(['push', remoteName, 'HEAD']);
runGit(['push', remoteName, `v${version}`]);

console.log(`[git-push] 完成：v${version} 已提交并推送。`);