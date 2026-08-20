import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { normalizeSwagger2 } from '../utils/normalize-swagger2';
import { resolveRefs } from '../utils/resolve-refs';
import { truncateText } from '../utils/truncate';
import { McpSourceError } from './errors';
import { defaultLogger, LoggerLike } from './logger';

/** 单个 spec 文件大小上限（20MB） */
const DEFAULT_MAX_SPEC_SIZE = 20 * 1024 * 1024;
/** spec 缓存有效期（5 分钟） */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
/** 最多缓存的数据源数量（超出淘汰最旧） */
const DEFAULT_CACHE_LIMIT = 10;
/** 详情输出默认截断长度（字符） */
export const DETAIL_MAX_LENGTH = 100 * 1024;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** spec 缓存条目 */
interface SpecCacheEntry {
	/** 归一化后的 OpenAPI 3.x 文档 */
	doc: any;
	/** 原始文件字节数 */
	size: number;
	/** 来源规范版本（如 openapi 3.0.0 / swagger 2.0） */
	sourceSpecVersion: string;
	loadedAt: number;
}

/** 全量导出的分段选项 */
export type SpecSection = 'full' | 'paths' | 'schemas' | 'info';

/** OpenapiService 构造选项 */
export interface OpenapiServiceOptions {
	/** 自定义 axios 实例（用于测试注入 / 代理 / 拦截器） */
	axiosInstance?: AxiosInstance;
	/** 日志器，默认 console */
	logger?: LoggerLike;
	/** 单个 spec 文件大小上限（字节），默认 20MB */
	maxSpecSize?: number;
	/** 缓存有效期（毫秒），默认 5 分钟 */
	cacheTtlMs?: number;
	/** 最多缓存的数据源数量，默认 10 */
	cacheLimit?: number;
}

/**
 * OpenAPI/Swagger 文档加载、解析、缓存与查询服务
 * 纯 TypeScript 实现，无框架依赖（可从 NestJS 项目直接解耦复用）
 */
export class OpenapiService {
	private readonly cache = new Map<string, SpecCacheEntry>();
	private readonly http: AxiosInstance;
	private readonly logger: LoggerLike;
	private readonly maxSpecSize: number;
	private readonly cacheTtlMs: number;
	private readonly cacheLimit: number;

	constructor(options: OpenapiServiceOptions = {}) {
		this.http = options.axiosInstance ?? axios;
		this.logger = options.logger ?? defaultLogger;
		this.maxSpecSize = options.maxSpecSize ?? DEFAULT_MAX_SPEC_SIZE;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
	}

	// ---------- 查询方法 ----------

	/** spec 概览：info/servers/tags 分组统计/接口总数 */
	async getOverview(source: string) {
		const { doc, size, sourceSpecVersion } = await this.loadSpec(source);

		const tagStats = new Map<string, { description?: string; count: number }>();
		let totalOperations = 0;
		for (const pathItem of Object.values<any>(doc.paths || {})) {
			for (const method of HTTP_METHODS) {
				const op = pathItem && pathItem[method];
				if (!op) {
					continue;
				}
				totalOperations++;
				const tags: string[] = op.tags && op.tags.length ? op.tags : ['(未分组)'];
				for (const tag of tags) {
					const stat = tagStats.get(tag) || { count: 0 };
					stat.count++;
					tagStats.set(tag, stat);
				}
			}
		}
		// doc.tags 带 description，合并进统计结果
		const descMap = new Map<string, string>();
		for (const t of doc.tags || []) {
			descMap.set(t.name, t.description);
		}

		return {
			source,
			sourceSpecVersion,
			normalizedFromSwagger2: sourceSpecVersion.startsWith('swagger'),
			info: doc.info,
			servers: doc.servers || [],
			totalOperations,
			pathCount: Object.keys(doc.paths || {}).length,
			specSizeBytes: size,
			tags: Array.from(tagStats.entries())
				.map(([name, stat]) => ({
					name,
					description: descMap.get(name),
					count: stat.count,
				}))
				.sort((a, b) => b.count - a.count),
		};
	}

	/** 接口列表/搜索：按 path/summary/description/tags/operationId 关键词过滤 */
	async searchApis(source: string, keyword?: string, limit = 50) {
		const { doc } = await this.loadSpec(source);

		const items: Array<{
			method: string;
			path: string;
			summary?: string;
			operationId?: string;
			tags: string[];
			description?: string;
		}> = [];
		for (const [p, pathItem] of Object.entries<any>(doc.paths || {})) {
			for (const method of HTTP_METHODS) {
				const op = pathItem && pathItem[method];
				if (!op) {
					continue;
				}
				items.push({
					method: method.toUpperCase(),
					path: p,
					summary: op.summary,
					operationId: op.operationId,
					tags: op.tags || [],
					description: op.description,
				});
			}
		}

		let matched = items;
		if (keyword) {
			const kw = keyword.toLowerCase();
			matched = items.filter(it =>
				[it.path, it.summary, it.operationId, it.description, it.tags.join(',')]
					.join(' ')
					.toLowerCase()
					.includes(kw)
			);
		}

		// description 通常较长，返回列表时去掉，详情用 get-api-detail 查看
		const result = matched.slice(0, limit).map(({ description, ...rest }) => rest);
		return {
			keyword: keyword || null,
			total: matched.length,
			returned: result.length,
			items: result,
		};
	}

	/** 接口详情：参数/请求体/响应结构，$ref 递归展开 */
	async getApiDetail(source: string, method: string, apiPath: string) {
		const { doc } = await this.loadSpec(source);
		const m = method.toLowerCase();
		if (!HTTP_METHODS.includes(m)) {
			throw new McpSourceError('UNSUPPORTED_METHOD', `不支持的 method: ${method}`, {
				statusCode: 400,
			});
		}

		const pathItem = (doc.paths || {})[apiPath];
		const op = pathItem && pathItem[m];
		if (!op) {
			throw new McpSourceError(
				pathItem
					? 'METHOD_NOT_FOUND'
					: 'PATH_NOT_FOUND',
				pathItem
					? `路径 ${apiPath} 不存在 ${method.toUpperCase()} 方法，可用方法: ${
							HTTP_METHODS.filter(x => pathItem[x])
								.map(x => x.toUpperCase())
								.join(', ') || '无'
						}`
					: `路径不存在: ${apiPath}（可先用 search-apis 查询确切路径）`,
				{ statusCode: 404 }
			);
		}

		// 合并 path 级公共参数与 operation 级参数
		const mergedParams = [...(pathItem.parameters || []), ...(op.parameters || [])];

		return {
			method: m.toUpperCase(),
			path: apiPath,
			summary: op.summary,
			description: op.description,
			operationId: op.operationId,
			tags: op.tags || [],
			deprecated: op.deprecated || false,
			servers: doc.servers || [],
			security: op.security || doc.security,
			parameters: resolveRefs(mergedParams, doc),
			requestBody: op.requestBody ? resolveRefs(op.requestBody, doc) : undefined,
			responses: resolveRefs(op.responses, doc),
		};
	}

	/** 全量导出 spec（可分段），超长截断 */
	async getSpecDump(
		source: string,
		format: 'json' | 'yaml' = 'json',
		section: SpecSection = 'full',
		maxLength = 50000
	) {
		const { doc } = await this.loadSpec(source);

		let part: any;
		switch (section) {
			case 'paths':
				part = { paths: doc.paths };
				break;
			case 'schemas':
				part = { components: { schemas: (doc.components || {}).schemas || {} } };
				break;
			case 'info':
				part = {
					openapi: doc.openapi,
					info: doc.info,
					servers: doc.servers,
					tags: doc.tags,
				};
				break;
			default:
				part = doc;
		}

		const serialized = format === 'yaml' ? stringifyYaml(part) : JSON.stringify(part, null, 2);
		const { text, truncated, totalLength } = truncateText(serialized, maxLength);
		return { format, section, truncated, totalLength, content: text };
	}

	// ---------- 缓存管理 ----------

	/** 刷新缓存：不传 source 刷新全部已缓存源，传 source 强制重载该源（未缓存则预热入缓存） */
	async refreshCache(source?: string) {
		if (source !== undefined) {
			// 单源：强制重载（未缓存过的源=预热入缓存），失败直接向上抛，由调用方决定如何标记
			const entry = await this.loadSpec(source, true);
			return {
				refreshed: [source],
				failed: [],
				size: entry.size,
				sourceSpecVersion: entry.sourceSpecVersion,
			};
		}

		// 全源：对缓存 key 做快照，逐个强制重载；单个失败不阻塞其他，失败源保留旧缓存（serve-stale）
		const sources = Array.from(this.cache.keys());
		if (sources.length === 0) {
			return { refreshed: [], failed: [], note: '缓存为空，没有可刷新的文档源' };
		}

		const refreshed: string[] = [];
		const failed: Array<{ source: string; error: string }> = [];
		for (const s of sources) {
			try {
				await this.loadSpec(s, true);
				refreshed.push(s);
			} catch (e: any) {
				failed.push({ source: s, error: e.message });
			}
		}
		return { refreshed, failed };
	}

	// ---------- 加载 / 解析 / 缓存 ----------

	/** 加载 spec（带 TTL 缓存），返回归一化后的 OpenAPI 3.x 文档 */
	private async loadSpec(source: string, force = false): Promise<SpecCacheEntry> {
		const cached = this.cache.get(source);
		if (!force && cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
			// 命中缓存时刷新位置，实现简单 LRU
			this.cache.delete(source);
			this.cache.set(source, cached);
			this.logger.debug?.(`[openapi-service] 缓存命中: ${source}`);
			return cached;
		}

		const raw = await this.fetchSource(source);
		const parsed = this.parseSpec(raw);
		const sourceSpecVersion = parsed.openapi
			? `openapi ${parsed.openapi}`
			: `swagger ${parsed.swagger}`;
		const doc = parsed.openapi ? parsed : normalizeSwagger2(parsed);

		const entry: SpecCacheEntry = {
			doc,
			size: typeof raw === 'string' ? Buffer.byteLength(raw) : JSON.stringify(raw).length,
			sourceSpecVersion,
			loadedAt: Date.now(),
		};
		this.cache.delete(source);
		this.cache.set(source, entry);
		this.logger.debug?.(
			`[openapi-service] 加载完成: ${source} (${entry.size} bytes, ${entry.sourceSpecVersion})`
		);
		// Map 迭代顺序即插入顺序，超出容量淘汰最旧
		while (this.cache.size > this.cacheLimit) {
			const oldest = this.cache.keys().next().value as string;
			this.cache.delete(oldest);
		}
		return entry;
	}

	/** 获取数据源：URL 下载或本地文件读取 */
	private async fetchSource(source: string): Promise<string | any> {
		if (/^https?:\/\//i.test(source)) {
			try {
				const resp = await this.http.get(source, {
					responseType: 'text',
					maxContentLength: this.maxSpecSize,
					timeout: 30000,
				});
				// axios 可能已自动 JSON.parse（data 为对象），两种情况都接受
				return resp.data;
			} catch (e: any) {
				throw new McpSourceError('DOWNLOAD_FAILED', `下载文档失败: ${e.message}`, {
					statusCode: 502,
					cause: e,
				});
			}
		}

		// 本地文件：限制扩展名与大小
		const resolved = path.resolve(source);
		const ext = path.extname(resolved).toLowerCase();
		if (!['.json', '.yaml', '.yml'].includes(ext)) {
			throw new McpSourceError('INVALID_EXTENSION', '本地文件仅支持 .json / .yaml / .yml', {
				statusCode: 400,
			});
		}
		let size: number;
		try {
			const stat = await fs.stat(resolved);
			if (!stat.isFile()) {
				throw new Error('不是文件');
			}
			size = stat.size;
		} catch (e: any) {
			throw new McpSourceError('FILE_READ_FAILED', `读取本地文件失败: ${resolved} (${e.message})`, {
				statusCode: 400,
				cause: e,
			});
		}
		if (size > this.maxSpecSize) {
			throw new McpSourceError(
				'FILE_TOO_LARGE',
				`文件超过 ${this.maxSpecSize / 1024 / 1024}MB 上限: ${resolved}`,
				{ statusCode: 400 }
			);
		}
		try {
			return await fs.readFile(resolved, 'utf-8');
		} catch (e: any) {
			throw new McpSourceError('FILE_READ_FAILED', `读取本地文件失败: ${e.message}`, {
				statusCode: 400,
				cause: e,
			});
		}
	}

	/** 解析 spec 文本：先按 JSON，失败再按 YAML；并校验规范版本 */
	private parseSpec(raw: string | any): any {
		let parsed: any;
		if (typeof raw === 'string') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				try {
					parsed = parseYaml(raw);
				} catch {
					throw new McpSourceError(
						'INVALID_DOCUMENT',
						'文档解析失败：既不是合法 JSON 也不是合法 YAML',
						{ statusCode: 400 }
					);
				}
			}
		} else {
			parsed = raw;
		}

		if (
			!parsed ||
			typeof parsed !== 'object' ||
			(!parsed.openapi && parsed.swagger !== '2.0')
		) {
			throw new McpSourceError(
				'INVALID_DOCUMENT',
				'无法识别的文档：仅支持 OpenAPI 3.x 或 Swagger 2.0 规范',
				{ statusCode: 400 }
			);
		}
		return parsed;
	}
}
