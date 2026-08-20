/**
 * stdio MCP server 启动器（库 API）
 * 供在 Node 程序内嵌启动 stdio 模式 MCP server（CLI 也是基于此实现的薄壳）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, McpServerOptions } from './mcp-server';
import { stderrLogger } from './service/logger';
import { OpenapiService } from './service/openapi.service';

/** startStdioServer 选项 */
export interface StdioServerOptions extends McpServerOptions {
	/** 自定义 OpenapiService 实例（如共享缓存 / 注入测试替身） */
	service?: OpenapiService;
}

/** startStdioServer 返回句柄 */
export interface StdioServerHandle {
	server: McpServer;
	transport: StdioServerTransport;
	/** 关闭 server 并断开连接 */
	close(): Promise<void>;
}

/**
 * 启动 stdio 模式 MCP server（stdin/stdout JSON-RPC 通信）
 * 日志一律写入 stderr，保护 stdout 协议通道
 */
export async function startStdioServer(options: StdioServerOptions = {}): Promise<StdioServerHandle> {
	// stdio 模式下日志必须走 stderr，不能使用默认的 console（info/debug 会写 stdout）
	const logger = options.logger ?? stderrLogger;
	const service = options.service ?? new OpenapiService({ logger });

	const server = createMcpServer(service, {
		defaultSource: options.defaultSource,
		logger,
		serverInfo: options.serverInfo,
	});
	const transport = new StdioServerTransport();
	await server.connect(transport);

	return {
		server,
		transport,
		close: async () => {
			await server.close();
		},
	};
}
