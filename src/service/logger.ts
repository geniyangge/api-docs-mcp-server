/**
 * 可注入的日志接口
 * 默认使用 console；使用者可传入自定义 logger（如 log4js / pino 的实例）屏蔽或重定向输出。
 */

/** 日志器最小接口（仅要求 error，其余可选） */
export interface LoggerLike {
	error(...args: unknown[]): void;
	warn?(...args: unknown[]): void;
	info?(...args: unknown[]): void;
	debug?(...args: unknown[]): void;
}

/** 默认日志器：console */
export const defaultLogger: LoggerLike = console;

/** 空日志器（静默模式，供测试/关闭日志场景使用） */
export const silentLogger: LoggerLike = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
};

/**
 * stderr 日志器：所有级别均写入 stderr
 * 专为 stdio MCP 模式设计——stdout 是 JSON-RPC 协议通道，任何日志写入 stdout 都会破坏协议
 */
export const stderrLogger: LoggerLike = {
	error: (...args) => console.error(...args),
	warn: (...args) => console.error(...args),
	info: (...args) => console.error(...args),
	debug: (...args) => console.error(...args),
};
