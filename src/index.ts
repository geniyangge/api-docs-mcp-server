/**
 * api-docs-mcp-server
 * 将 OpenAPI/Swagger 接口文档暴露为 MCP 工具的服务器（框架无关，支持 Express / 原生 Node http）
 */

// MCP 服务
export { createMcpServer } from './mcp-server';
export type { McpServerOptions } from './mcp-server';

// stdio 模式（内嵌启动 / CLI 同款逻辑）
export { startStdioServer } from './stdio-server';
export type { StdioServerOptions, StdioServerHandle } from './stdio-server';

// HTTP 处理器（Express 中间件 / Node http）
export { createMcpHttpHandler } from './http-handler';
export type { McpHttpHandler, McpHttpHandlerOptions } from './http-handler';

// 核心服务
export { OpenapiService, DETAIL_MAX_LENGTH } from './service/openapi.service';
export type { OpenapiServiceOptions, SpecSection } from './service/openapi.service';

// 错误类型
export { McpSourceError } from './service/errors';
export type { McpErrorKind } from './service/errors';

// 日志接口
export { defaultLogger, silentLogger, stderrLogger } from './service/logger';
export type { LoggerLike } from './service/logger';

// 工具函数
export { truncateText } from './utils/truncate';
export type { TruncateResult } from './utils/truncate';
export { resolveRefs } from './utils/resolve-refs';
export { normalizeSwagger2 } from './utils/normalize-swagger2';
