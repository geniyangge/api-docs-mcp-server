import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server';
import { McpSourceError } from './service/errors';
import { defaultLogger, LoggerLike } from './service/logger';
import { OpenapiService } from './service/openapi.service';

/** createMcpHttpHandler 选项 */
export interface McpHttpHandlerOptions {
	/** 默认文档源（可被请求 URL 的 ?source= 参数或 x-mcp-source 请求头覆盖） */
	defaultSource?: string;
	/** 自定义 OpenapiService 实例（如需要共享缓存 / 注入测试替身） */
	service?: OpenapiService;
	/** 日志器，默认 console */
	logger?: LoggerLike;
	/** HTTP 请求体大小上限（字节），默认 10MB */
	maxBodySize?: number;
	/** MCP server 元信息 */
	serverInfo?: { name?: string; version?: string };
}

/**
 * MCP HTTP 处理器（无状态 Streamable HTTP 模式）
 * 框架无关：兼容 Express 中间件签名与 Node 原生 http server 回调。
 *
 * Express 用法：
 *   app.use(express.json());
 *   app.use('/mcp', createMcpHttpHandler({ defaultSource: 'https://.../openapi.json' }));
 *
 * 原生 Node 用法：
 *   http.createServer(async (req, res) => { await handler(req, res); });
 */
export type McpHttpHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	next?: (err?: unknown) => void
) => Promise<void>;

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/** 发送 MCP JSON-RPC 错误响应（若响应尚未开始） */
function sendJsonRpcError(
	res: ServerResponse,
	statusCode: number,
	message: string,
	code = -32000
): void {
	if (res.headersSent) {
		return;
	}
	const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
	res.writeHead(statusCode, { 'Content-Type': 'application/json' });
	res.end(body);
}

/** 从请求流中读取并解析 body（JSON），空 body 返回 undefined */
async function readBody(req: IncomingMessage, maxSize: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > maxSize) {
			throw new McpSourceError('BODY_TOO_LARGE', `请求体超过 ${maxSize} 字节上限`, {
				statusCode: 413,
			});
		}
		chunks.push(buf);
	}
	if (chunks.length === 0) {
		return undefined;
	}
	const text = Buffer.concat(chunks).toString('utf-8');
	if (!text.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch (e: any) {
		throw new McpSourceError('BODY_PARSE_FAILED', `请求体 JSON 解析失败: ${e.message}`, {
			statusCode: 400,
			cause: e,
		});
	}
}

/**
 * 创建无状态 MCP HTTP 处理器
 * 每次请求创建独立的 McpServer + Transport（保证请求间完全隔离，无请求 ID 冲突）
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions = {}): McpHttpHandler {
	const logger = options.logger ?? defaultLogger;
	const service = options.service ?? new OpenapiService({ logger });
	const defaultSource = options.defaultSource;
	const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;

	return async (req, res) => {
		// 无状态模式不支持 GET（SSE 流）与 DELETE（会话终止）
		if (req.method === 'GET' || req.method === 'DELETE') {
			sendJsonRpcError(
				res,
				405,
				'Method not allowed. 当前为无状态 MCP 服务，不支持 GET（SSE 流）/ DELETE（会话终止）'
			);
			return;
		}

		// 默认文档源：URL ?source= 参数优先，其次 x-mcp-source 请求头
		let querySource: string | undefined;
		try {
			querySource =
				new URL(req.url ?? '/', 'http://localhost').searchParams.get('source') ?? undefined;
		} catch {
			// 忽略非法 URL
		}
		const headerSource =
			typeof req.headers['x-mcp-source'] === 'string'
				? req.headers['x-mcp-source']
				: undefined;
		const effectiveDefaultSource = querySource || headerSource || defaultSource;

		const server = createMcpServer(service, {
			defaultSource: effectiveDefaultSource,
			logger,
			serverInfo: options.serverInfo,
		});
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // 无状态：不生成会话
			enableJsonResponse: true, // 普通 JSON 响应（非 SSE 流）
		});

		res.on('close', () => {
			transport.close();
			server.close();
		});

		try {
			await server.connect(transport);
			// body 已由上层 express.json() 解析时直接使用；否则自行读取并解析
			const preParsed = (req as { body?: unknown }).body;
			const body = preParsed !== undefined ? preParsed : await readBody(req, maxBodySize);
			await transport.handleRequest(req, res, body);
		} catch (e: any) {
			logger.error(`MCP 请求处理失败: ${e?.message ?? e}`);
			sendJsonRpcError(res, 500, `Internal server error: ${e?.message ?? e}`, -32603);
		}
	};
}
