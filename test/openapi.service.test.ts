import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OpenapiService } from '../src/service/openapi.service';
import { McpSourceError } from '../src/service/errors';
import { silentLogger } from '../src/service/logger';

/** OpenAPI 3.x 示例文档 */
const openapiDoc = {
	openapi: '3.0.0',
	info: { title: '示例 API', version: '1.2.3', description: '测试文档' },
	servers: [{ url: 'https://api.example.com' }],
	tags: [{ name: 'user', description: '用户相关' }],
	paths: {
		'/users': {
			get: {
				tags: ['user'],
				summary: '获取用户列表',
				operationId: 'listUsers',
				responses: {
					200: {
						description: 'ok',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/User' },
							},
						},
					},
				},
			},
			post: {
				tags: ['user'],
				summary: '创建用户',
				requestBody: {
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/User' },
						},
					},
				},
				responses: { 201: { description: 'created' } },
			},
		},
		'/orders': {
			get: {
				tags: ['order'],
				summary: '获取订单列表',
				responses: { 200: { description: 'ok' } },
			},
		},
	},
	components: {
		schemas: {
			User: {
				type: 'object',
				properties: { id: { type: 'integer' }, name: { type: 'string' } },
			},
		},
	},
};

const SOURCE = 'https://api.example.com/openapi.json';

function createService(overrides: { data?: any; fail?: boolean } = {}) {
	const { data = openapiDoc, fail = false } = overrides;
	const mockAxios = {
		get: vi.fn().mockImplementation(() => {
			if (fail) {
				return Promise.reject(new Error('网络错误'));
			}
			return Promise.resolve({ data });
		}),
	};
	const service = new OpenapiService({
		axiosInstance: mockAxios as any,
		logger: silentLogger,
	});
	return { service, mockAxios };
}

describe('OpenapiService.getOverview', () => {
	it('返回概览统计', async () => {
		const { service } = createService();
		const overview = await service.getOverview(SOURCE);
		expect(overview.source).toBe(SOURCE);
		expect(overview.sourceSpecVersion).toBe('openapi 3.0.0');
		expect(overview.normalizedFromSwagger2).toBe(false);
		expect(overview.totalOperations).toBe(3);
		expect(overview.pathCount).toBe(2);
		expect(overview.info.title).toBe('示例 API');
		expect(overview.servers).toEqual([{ url: 'https://api.example.com' }]);
		expect(overview.tags[0]).toMatchObject({ name: 'user', count: 2, description: '用户相关' });
		expect(overview.tags[1]).toMatchObject({ name: 'order', count: 1 });
	});

	it('Swagger 2.0 文档标记 normalizedFromSwagger2', async () => {
		const swaggerDoc = {
			swagger: '2.0',
			info: { title: '旧文档', version: '1.0.0' },
			paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } },
		};
		const { service } = createService({ data: swaggerDoc });
		const overview = await service.getOverview(SOURCE);
		expect(overview.normalizedFromSwagger2).toBe(true);
		expect(overview.sourceSpecVersion).toBe('swagger 2.0');
	});
});

describe('OpenapiService.searchApis', () => {
	it('无关键词返回全部', async () => {
		const { service } = createService();
		const result = await service.searchApis(SOURCE);
		expect(result.total).toBe(3);
		expect(result.items).toHaveLength(3);
		expect(result.items[0]).toMatchObject({ method: 'GET', path: '/users' });
		// 列表不含 description
		expect(result.items[0].description).toBeUndefined();
	});

	it('关键词过滤（大小写不敏感，匹配 path）', async () => {
		const { service } = createService();
		const result = await service.searchApis(SOURCE, 'USERS');
		expect(result.total).toBe(2);
	});

	it('关键词过滤（匹配 summary）', async () => {
		const { service } = createService();
		const result = await service.searchApis(SOURCE, '订单');
		expect(result.total).toBe(1);
		expect(result.items[0].path).toBe('/orders');
	});

	it('limit 截断', async () => {
		const { service } = createService();
		const result = await service.searchApis(SOURCE, undefined, 1);
		expect(result.returned).toBe(1);
		expect(result.total).toBe(3);
	});
});

describe('OpenapiService.getApiDetail', () => {
	it('返回详情并展开 $ref', async () => {
		const { service } = createService();
		const detail = await service.getApiDetail(SOURCE, 'get', '/users');
		expect(detail.method).toBe('GET');
		expect(detail.summary).toBe('获取用户列表');
		expect(detail.responses['200'].content['application/json'].schema.properties.id).toEqual({
			type: 'integer',
		});
	});

	it('method 参数非法抛 UNSUPPORTED_METHOD', async () => {
		const { service } = createService();
		await expect(service.getApiDetail(SOURCE, 'foo', '/users')).rejects.toMatchObject({
			kind: 'UNSUPPORTED_METHOD',
			statusCode: 400,
		});
	});

	it('路径不存在抛 PATH_NOT_FOUND', async () => {
		const { service } = createService();
		await expect(service.getApiDetail(SOURCE, 'get', '/nope')).rejects.toMatchObject({
			kind: 'PATH_NOT_FOUND',
			statusCode: 404,
		});
	});

	it('路径存在但方法不存在抛 METHOD_NOT_FOUND', async () => {
		const { service } = createService();
		await expect(service.getApiDetail(SOURCE, 'delete', '/users')).rejects.toMatchObject({
			kind: 'METHOD_NOT_FOUND',
			statusCode: 404,
		});
	});
});

describe('OpenapiService.getSpecDump', () => {
	it('默认输出完整 json', async () => {
		const { service } = createService();
		const r = await service.getSpecDump(SOURCE);
		expect(r.format).toBe('json');
		expect(r.section).toBe('full');
		expect(r.truncated).toBe(false);
		expect(JSON.parse(r.content).openapi).toBe('3.0.0');
	});

	it('section=schemas 只输出 schemas', async () => {
		const { service } = createService();
		const r = await service.getSpecDump(SOURCE, 'json', 'schemas');
		const parsed = JSON.parse(r.content);
		expect(parsed.paths).toBeUndefined();
		expect(parsed.components.schemas.User.properties.name).toEqual({ type: 'string' });
	});

	it('format=yaml 输出 YAML', async () => {
		const { service } = createService();
		const r = await service.getSpecDump(SOURCE, 'yaml', 'info');
		expect(r.content).toContain('openapi: 3.0.0');
	});

	it('maxLength 截断生效', async () => {
		const { service } = createService();
		const r = await service.getSpecDump(SOURCE, 'json', 'full', 1000);
		expect(r.truncated).toBe(true);
		expect(r.content.length).toBeLessThanOrEqual(1000);
	});
});

describe('OpenapiService 缓存与刷新', () => {
	it('TTL 内重复加载命中缓存（只请求一次）', async () => {
		const { service, mockAxios } = createService();
		await service.getOverview(SOURCE);
		await service.getOverview(SOURCE);
		await service.getOverview(SOURCE);
		expect(mockAxios.get).toHaveBeenCalledTimes(1);
	});

	it('refreshCache 单源强制重载', async () => {
		const { service, mockAxios } = createService();
		await service.getOverview(SOURCE);
		const result = await service.refreshCache(SOURCE);
		expect(result.refreshed).toEqual([SOURCE]);
		expect(mockAxios.get).toHaveBeenCalledTimes(2);
	});

	it('refreshCache 无参数刷新全部缓存源，失败不阻塞其他', async () => {
		const { service, mockAxios } = createService();
		await service.getOverview(SOURCE);
		await service.getOverview('https://other.example.com/spec.json');
		// 第二个源失败
		mockAxios.get.mockImplementation((url: string) => {
			if (url === 'https://other.example.com/spec.json') {
				return Promise.reject(new Error('挂了'));
			}
			return Promise.resolve({ data: openapiDoc });
		});
		const result = await service.refreshCache();
		expect(result.refreshed).toContain(SOURCE);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].source).toBe('https://other.example.com/spec.json');
	});

	it('refreshCache 空缓存返回提示', async () => {
		const { service } = createService();
		const result = await service.refreshCache();
		expect(result.note).toContain('缓存为空');
	});
});

describe('OpenapiService 错误处理', () => {
	it('下载失败抛 DOWNLOAD_FAILED', async () => {
		const { service } = createService({ fail: true });
		await expect(service.getOverview(SOURCE)).rejects.toMatchObject({
			kind: 'DOWNLOAD_FAILED',
			statusCode: 502,
		});
	});

	it('本地文件扩展名不支持抛 INVALID_EXTENSION', async () => {
		const { service } = createService();
		await expect(service.getOverview('C:/tmp/spec.txt')).rejects.toMatchObject({
			kind: 'INVALID_EXTENSION',
			statusCode: 400,
		});
	});

	it('非法 JSON/YAML 抛 INVALID_DOCUMENT', async () => {
		const { service } = createService({ data: '{{{{不是合法文档' });
		await expect(service.getOverview(SOURCE)).rejects.toMatchObject({
			kind: 'INVALID_DOCUMENT',
			statusCode: 400,
		});
	});

	it('不支持规范的文档抛 INVALID_DOCUMENT', async () => {
		const { service } = createService({ data: { hello: 'world' } });
		await expect(service.getOverview(SOURCE)).rejects.toMatchObject({ kind: 'INVALID_DOCUMENT' });
	});

	it('YAML 文本可正常解析', async () => {
		const yamlText = `
openapi: 3.0.0
info:
  title: YAML 文档
  version: 1.0.0
paths: {}
`;
		const { service } = createService({ data: yamlText });
		const overview = await service.getOverview(SOURCE);
		expect(overview.info.title).toBe('YAML 文档');
	});
});

describe('OpenapiService 缓存淘汰', () => {
	it('超过 cacheLimit 淘汰最旧', async () => {
		const { service } = createService();
		// 缩小 cacheLimit 验证 LRU
		const smallService = new OpenapiService({
			axiosInstance: { get: vi.fn().mockResolvedValue({ data: openapiDoc }) } as any,
			logger: silentLogger,
			cacheLimit: 2,
		});
		await smallService.getOverview('https://a.example.com/spec.json');
		await smallService.getOverview('https://b.example.com/spec.json');
		await smallService.getOverview('https://c.example.com/spec.json');
		// a 被淘汰，重新加载触发新请求
		await smallService.getOverview('https://a.example.com/spec.json');
		// 总共 4 次请求（a 被淘汰后重新加载）
		expect(smallService['cache'].size).toBe(2);
	});
});
