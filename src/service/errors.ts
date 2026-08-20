/**
 * 统一的错误类型，替代 NestJS HttpException
 * 携带 kind（机器可读的错误分类）与 statusCode（HTTP 语义），
 * 供上层（MCP 工具 / HTTP 中间件 / 日志）按需处理。
 */

/** 错误分类 */
export type McpErrorKind =
	/** 未指定文档源（工具未传 source 且服务端无默认源） */
	| 'SOURCE_NOT_SPECIFIED'
	/** URL 下载文档失败 */
	| 'DOWNLOAD_FAILED'
	/** 本地文件读取失败（不存在 / 非文件 / IO 错误） */
	| 'FILE_READ_FAILED'
	/** 本地文件扩展名不支持 */
	| 'INVALID_EXTENSION'
	/** 本地文件超过大小上限 */
	| 'FILE_TOO_LARGE'
	/** 文档解析失败或不是受支持的规范（OpenAPI 3.x / Swagger 2.0） */
	| 'INVALID_DOCUMENT'
	/** 不支持的 HTTP 方法（getApiDetail 的 method 参数非法） */
	| 'UNSUPPORTED_METHOD'
	/** 接口路径不存在 */
	| 'PATH_NOT_FOUND'
	/** 路径存在但该 HTTP 方法不存在 */
	| 'METHOD_NOT_FOUND'
	/** HTTP 请求体超过大小上限 */
	| 'BODY_TOO_LARGE'
	/** HTTP 请求体 JSON 解析失败 */
	| 'BODY_PARSE_FAILED';

/** 带分类的源数据错误 */
export class McpSourceError extends Error {
	constructor(
		public readonly kind: McpErrorKind,
		message: string,
		options: { statusCode?: number; cause?: unknown } = {}
	) {
		super(message);
		this.name = 'McpSourceError';
		this.statusCode = options.statusCode ?? 400;
		// ES2020 的 Error 构造器不支持 cause 参数，手动挂载（保留 cause 语义便于排查）
		if (options.cause !== undefined) {
			(this as any).cause = options.cause;
		}
	}

	/** HTTP 状态码语义（默认 400，下载类错误 502） */
	readonly statusCode: number;
}
