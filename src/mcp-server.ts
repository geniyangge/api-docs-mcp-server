import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OpenapiService, DETAIL_MAX_LENGTH } from './service/openapi.service';
import { defaultLogger, LoggerLike } from './service/logger';
import { truncateText } from './utils/truncate';

// 注意：SDK 锁定 1.16.0——1.30+ 的 zod v4 兼容类型在 TS 5.3（declaration: true）下会触发 TS2589，
// 1.16 使用经典 zod v3 类型，无此问题。如需升级 SDK，需先验证编译。

/** source 参数说明（多个工具共用） */
const SOURCE_DESC =
	'Swagger/OpenAPI 文档的 URL（http/https）或本地文件路径（.json/.yaml/.yml）；不传时使用服务端配置的默认文档';

/** createMcpServer 选项 */
export interface McpServerOptions {
	/** 默认文档源（来自 MCP 端点 URL 的 ?source= 参数或 x-mcp-source 请求头） */
	defaultSource?: string;
	/** 日志器，默认 console */
	logger?: LoggerLike;
	/** MCP server 元信息（客户端 initialize 响应中展示） */
	serverInfo?: {
		name?: string;
		version?: string;
	};
}

/**
 * 构造 MCP Server 并注册 openapi 文档工具
 * 无状态模式：每个请求创建新实例（工具注册为纯内存操作，开销极小）
 */
export function createMcpServer(service: OpenapiService, options: McpServerOptions = {}): McpServer {
	const logger = options.logger ?? defaultLogger;
	const defaultSource = options.defaultSource;

	const server = new McpServer(
		{
			name: options.serverInfo?.name ?? 'api-docs-mcp-server',
			version: options.serverInfo?.version ?? '1.0.0',
		},
		{ capabilities: { tools: {} } }
	);

	// 解析数据源：调用参数优先，其次服务端 URL 上配置的默认源
	const requireSource = (s?: string): string => {
		const v = s || defaultSource;
		if (!v) {
			throw new Error(
				'未指定文档源：请在工具调用时传 source 参数，或在 MCP 服务 URL 上加 ?source=<文档地址>'
			);
		}
		return v;
	};

	const handleError = (e: any) => {
		logger.error(`MCP 工具执行失败: ${e?.message ?? e}`);
		return {
			content: [{ type: 'text' as const, text: `执行失败: ${e?.message ?? e}` }],
			isError: true,
		};
	};

	// 1. 文档概览
	server.registerTool(
		'get-spec-overview',
		{
			title: '获取接口文档概览',
			description:
				'读取 Swagger/OpenAPI 文档，返回 info、servers、tags 分组统计、接口总数等概览信息。通常这是使用其它工具前的第一步。参数 source：文档的 URL（http/https）或本地文件路径（.json/.yaml/.yml），可选，不传时使用服务端配置的默认文档。',
			inputSchema: {
				source: z.string().optional().describe(SOURCE_DESC),
			},
		},
		async ({ source }: { source?: string }) => {
			try {
				const json = JSON.stringify(
					await service.getOverview(requireSource(source)),
					null,
					2
				);
				const { text } = truncateText(json, DETAIL_MAX_LENGTH);
				return { content: [{ type: 'text', text }] };
			} catch (e: any) {
				return handleError(e);
			}
		}
	);

	// 2. 接口搜索
	server.registerTool(
		'search-apis',
		{
			title: '搜索接口列表',
			description:
				'按关键词搜索接口（匹配 path/summary/description/tags/operationId，大小写不敏感），返回 method/path/summary/tags 列表，获取确切 path 后用 get-api-detail 查看详情。参数：source 同上；keyword 搜索关键词（如「充值」「user」，不传返回全部）；limit 最多返回条数（默认 50，最大 200）。',
			inputSchema: {
				source: z.string().optional().describe(SOURCE_DESC),
				keyword: z
					.string()
					.optional()
					.describe('搜索关键词，如「充值」「user」；不传则返回全部'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.default(50)
					.describe('最多返回条数，默认 50'),
			},
		},
		async ({
			source,
			keyword,
			limit,
		}: {
			source?: string;
			keyword?: string;
			limit?: number;
		}) => {
			try {
				const json = JSON.stringify(
					await service.searchApis(requireSource(source), keyword, limit),
					null,
					2
				);
				const { text } = truncateText(json, DETAIL_MAX_LENGTH);
				return { content: [{ type: 'text', text }] };
			} catch (e: any) {
				return handleError(e);
			}
		}
	);

	// 3. 接口详情
	server.registerTool(
		'get-api-detail',
		{
			title: '获取接口详情',
			description:
				'按 method + path 返回接口完整详情：参数、请求体、响应结构，所有 $ref 引用（数据模型）已递归展开，循环引用会标记为 $ref-cycle。参数：source 同上；method HTTP 方法（如 GET/POST）；path 接口路径，需与文档完全一致（可先用 search-apis 查询）。',
			inputSchema: {
				source: z.string().optional().describe(SOURCE_DESC),
				method: z.string().describe('HTTP 方法，如 GET/POST'),
				path: z.string().describe('接口路径，需与文档完全一致（可先用 search-apis 查询）'),
			},
		},
		async ({ source, method, path }: { source?: string; method: string; path: string }) => {
			try {
				const json = JSON.stringify(
					await service.getApiDetail(requireSource(source), method, path),
					null,
					2
				);
				const { text } = truncateText(json, DETAIL_MAX_LENGTH);
				return { content: [{ type: 'text', text }] };
			} catch (e: any) {
				return handleError(e);
			}
		}
	);

	// 4. 全量导出
	server.registerTool(
		'get-openapi-spec',
		{
			title: '导出完整 OpenAPI 文档',
			description:
				'导出完整（或分段）的 OpenAPI 3.x 文档文本，超长自动截断。参数：source 同上；format 输出格式 json/yaml（默认 json）；section 导出分段 full/paths/schemas/info（默认 full）；max_length 最大返回字符数（默认 50000）。大文档建议用 section 分段获取，或优先使用概览/搜索/详情工具。',
			inputSchema: {
				source: z.string().optional().describe(SOURCE_DESC),
				format: z.enum(['json', 'yaml']).default('json').describe('输出格式，默认 json'),
				section: z
					.enum(['full', 'paths', 'schemas', 'info'])
					.default('full')
					.describe('导出分段，默认 full'),
				max_length: z
					.number()
					.int()
					.min(1000)
					.max(1000000)
					.default(50000)
					.describe('最大返回字符数，默认 50000'),
			},
		},
		async ({
			source,
			format,
			section,
			max_length,
		}: {
			source?: string;
			format?: 'json' | 'yaml';
			section?: 'full' | 'paths' | 'schemas' | 'info';
			max_length?: number;
		}) => {
			// content 是已截断的原始文本（json/yaml），直接拼接返回，避免二次 JSON 转义
			try {
				const r = await service.getSpecDump(
					requireSource(source),
					format,
					section,
					max_length
				);
				const header = `[openapi-docs format=${r.format} section=${r.section} truncated=${r.truncated} totalLength=${r.totalLength}]\n`;
				return { content: [{ type: 'text', text: header + r.content }] };
			} catch (e: any) {
				return handleError(e);
			}
		}
	);

	// 5. 刷新文档缓存
	server.registerTool(
		'refresh-cache',
		{
			title: '刷新文档缓存',
			description:
				'强制重新加载文档源并立即替换缓存（无需等待 5 分钟过期）。参数 source 可选：传了只刷新该文档源（若从未加载过则加载并加入缓存）；不传则刷新全部已缓存源（注意：不等于默认文档；若默认文档从未被加载则不在刷新之列）。刷新失败时保留旧缓存。',
			inputSchema: {
				source: z.string().optional().describe(SOURCE_DESC),
			},
		},
		async ({ source }: { source?: string }) => {
			try {
				const json = JSON.stringify(await service.refreshCache(source), null, 2);
				const { text } = truncateText(json, DETAIL_MAX_LENGTH);
				return { content: [{ type: 'text', text }] };
			} catch (e: any) {
				return handleError(e);
			}
		}
	);

	return server;
}
