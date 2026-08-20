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

// ---------------------------------------------------------------- 常量

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
/** commit / tag / 变更检测关心的版本文件 */
const VERSION_FILES = ['package.json', 'package-lock.json'];
/** 环境变量文件：固定读取项目根目录下的 .env */
const ENV_FILE = '.env';

// 最先加载环境变量：下方求值的 DRY_RUN 等常量依赖 .env 的内容
loadEnvFile();

const DRY_RUN = Boolean(process.env.RELEASE_DRY_RUN);

// ---------------------------------------------------------------- 通用工具

/** 打印错误并退出进程 */
function fail(msg) {
	console.error(`[git-push] ${msg}`);
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

/** 执行 git 写操作（用 -c 注入提交身份，不写任何 git config） */
function runGit(args) {
	if (DRY_RUN) {
		console.log(`[git-push][dry-run] 将执行: git ${args.join(' ')}`);
		return;
	}
	const identity = ['-c', `user.name=${process.env.GIT_USER_NAME}`, '-c', `user.email=${process.env.GIT_USER_EMAIL}`];
	try {
		execFileSync('git', [...identity, ...args], { cwd: ROOT, stdio: 'inherit' });
	} catch (err) {
		fail(`git ${args.join(' ')} 失败: ${describeError(err)}`);
	}
}

// ---------------------------------------------------------------- 环境变量

/**
 * 加载环境变量文件（固定读取项目根目录的 .env，文件不存在时静默跳过）。
 * - 不覆盖已存在的环境变量（shell 已设置的优先级高于 .env）
 * - 优先 Node 原生 process.loadEnvFile（>= 21.7），老版本降级手动解析
 */
function loadEnvFile() {
	const abs = path.resolve(ROOT, ENV_FILE);
	if (typeof process.loadEnvFile === 'function') {
		try {
			process.loadEnvFile(abs);
			return;
		} catch (err) {
			if (err.code === 'ENOENT') return;
			fail(`加载 ${ENV_FILE} 失败: ${err.message}`);
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

// ---------------------------------------------------------------- 业务逻辑

/** 检测 package.json / package-lock.json 是否有版本变更 */
function hasVersionChange() {
	const changed = gitRead(['status', '--porcelain', '--', ...VERSION_FILES]);
	return Boolean(changed);
}

/** 校验提交身份环境变量，缺失时直接退出 */
function resolveIdentity() {
	const { GIT_USER_NAME: userName, GIT_USER_EMAIL: userEmail } = process.env;
	if (!userName || !userEmail) {
		fail('缺少 GIT_USER_NAME / GIT_USER_EMAIL，请参考 .env.example 配置');
	}
}

/** 读取 package.json 的版本号（x.y.z 格式） */
function readVersion() {
	const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
		fail(`无法解析版本号: ${pkg.version}`);
	}
	return pkg.version;
}

/** 提交版本变更并打 annotated tag */
function commitAndTag(version) {
	runGit(['add', ...VERSION_FILES]);
	runGit(['commit', '-m', `chore: 版本号升级至 ${version}`]);
	runGit(['tag', '-a', `v${version}`, '-m', `release v${version}`]);
}

/**
 * 确认目标远程存在：给了 GIT_REMOTE_URL 则新建/改写 remote，
 * 否则要求仓库已存在同名 remote。返回解析出的远程名。
 */
function resolveRemote() {
	const name = process.env.GIT_REMOTE_NAME || 'origin';
	const url = process.env.GIT_REMOTE_URL;
	const existing = gitRead(['remote'])
		.split(/\r?\n/)
		.filter(Boolean);

	if (url) {
		if (existing.includes(name)) {
			runGit(['remote', 'set-url', name, url]);
		} else {
			runGit(['remote', 'add', name, url]);
		}
	} else if (!existing.includes(name)) {
		fail(`远程 ${name} 不存在，请配置 GIT_REMOTE_URL 或先 git remote add ${name}`);
	}
	return name;
}

/** 推送源码提交与版本 tag */
function push(remoteName, version) {
	runGit(['push', remoteName, 'HEAD']);
	runGit(['push', remoteName, `v${version}`]);
}

// ---------------------------------------------------------------- 主流程

function main() {
	// 1. 无版本变更时跳过（直接 npm publish 未走 release 脚本的场景）
	if (!hasVersionChange()) {
		console.warn('[git-push] package.json 无版本变更（直接 npm publish 未走 release 脚本？），跳过 commit/tag/push');
		return;
	}

	// 2. 校验身份与版本号
	resolveIdentity();
	const version = readVersion();
	console.log(`[git-push] 记录并推送 v${version}`);

	// 3. 提交版本变更并打 tag
	commitAndTag(version);

	// 4. push 源码与 tag
	const remoteName = resolveRemote();
	push(remoteName, version);

	console.log(`[git-push] 完成：v${version} 已提交并推送。`);
}

main();