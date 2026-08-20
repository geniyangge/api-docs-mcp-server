import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenapiService } from '../src/service/openapi.service';
import { silentLogger } from '../src/service/logger';
import { createMcpHttpHandler } from '../src/http-handler';

const openapiDoc = {
	openapi: '3.0.0',
	info: { title: '集成测试 API', version: '1.0.0' },
	paths: {
		'/users': {
			get: {
				tags: ['user'],
				summary: '获取用户列表',
				responses: {
					200: {
						description: 'ok',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { id: { type: 'integer' } },
								},
							},
						},
					},
				},
			},
		},
	},
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
	const service = new OpenapiService({
		axiosInstance: { get: vi.fn().mockResolvedValue({ data: openapiDoc }) } as any,
		logger: silentLogger,
	});
	const handler = createMcpHttpHandler({
		service,
		defaultSource: 'https://mock.example.com/openapi.json',
	});

	server = createServer(async (req, res) => {
		await handler(req, res);
	});
	await new Promise<void>(resolve => server.listen(0, resolve));
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
	await new Promise<void>(resolve => server.close(() => resolve()));
});

async function post(body: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(baseUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			// MCP 协议要求：客户端必须接受 application/json 和 text/event-stream
			Accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as any };
}

describe('createMcpHttpHandler（原生 Node http）', () => {
	it('GET 返回 405', async () => {
		const res = await fetch(baseUrl);
		expect(res.status).toBe(405);
		const json = (await res.json()) as any;
		expect(json.error.code).toBe(-32000);
	});

	it('DELETE 返回 405', async () => {
		const res = await fetch(baseUrl, { method: 'DELETE' });
		expect(res.status).toBe(405);
	});

	it('POST 空 body 返回 JSON-RPC 错误（非法请求）', async () => {
		const res = await fetch(baseUrl, {
			method: 'POST',
			headers: { Accept: 'application/json, text/event-stream' },
		});
		// 无 body / 无 Content-Type：SDK 返回 JSON-RPC 错误（415/400/500 视检查顺序而定）
		expect([400, 415, 500]).toContain(res.status);
		const json = (await res.json()) as any;
		expect(json.jsonrpc).toBe('2.0');
		expect(json.error).toBeDefined();
	});

	it('initialize 返回 serverInfo 与 tools capability', async () => {
		const { status, json } = await post({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: { name: 'vitest', version: '1.0.0' },
			},
		});
		expect(status).toBe(200);
		expect(json.result.serverInfo.name).toBe('api-docs-mcp-server');
		// McpServer 注册工具后 capabilities.tools 自动带 listChanged
		expect(json.result.capabilities.tools).toEqual({ listChanged: true });
	});

	it('tools/list 返回 5 个工具', async () => {
		const { status, json } = await post({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {},
		});
		expect(status).toBe(200);
		expect(json.result.tools).toHaveLength(5);
		const names = json.result.tools.map((t: any) => t.name);
		expect(names).toEqual([
			'get-spec-overview',
			'search-apis',
			'get-api-detail',
			'get-openapi-spec',
			'refresh-cache',
		]);
	});

	it('tools/call get-spec-overview 返回概览文本', async () => {
		const { status, json } = await post({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'get-spec-overview', arguments: {} },
		});
		expect(status).toBe(200);
		expect(json.result.isError).toBeUndefined();
		const text = json.result.content[0].text;
		expect(text).toContain('集成测试 API');
		expect(text).toContain('totalOperations');
	});

	it('tools/call 无默认源且未传 source 时返回 isError 提示', async () => {
		const noSourceService = new OpenapiService({ logger: silentLogger });
		const noSourceHandler = createMcpHttpHandler({ service: noSourceService });
		const tmpServer = createServer(async (req, res) => {
			await noSourceHandler(req, res);
		});
		await new Promise<void>(resolve => tmpServer.listen(0, resolve));
		const { port } = tmpServer.address() as AddressInfo;
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'get-spec-overview', arguments: {} },
			}),
		});
		const json = (await res.json()) as any;
		expect(json.result.isError).toBe(true);
		expect(json.result.content[0].text).toContain('未指定文档源');
		await new Promise<void>(resolve => tmpServer.close(() => resolve()));
	});

	it('URL ?source= 参数作为默认源生效', async () => {
		// 使用无默认源的 handler，但通过 URL 参数传入 source
		const service = new OpenapiService({
			axiosInstance: { get: vi.fn().mockResolvedValue({ data: openapiDoc }) } as any,
			logger: silentLogger,
		});
		const handler = createMcpHttpHandler({ service });
		const tmpServer = createServer(async (req, res) => {
			await handler(req, res);
		});
		await new Promise<void>(resolve => tmpServer.listen(0, resolve));
		const { port } = tmpServer.address() as AddressInfo;
		const res = await fetch(
			`http://127.0.0.1:${port}/mcp?source=${encodeURIComponent('https://mock.example.com/openapi.json')}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'get-spec-overview', arguments: {} },
				}),
			}
		);
		const json = (await res.json()) as any;
		expect(json.result.isError).toBeUndefined();
		expect(json.result.content[0].text).toContain('集成测试 API');
		await new Promise<void>(resolve => tmpServer.close(() => resolve()));
	});
});
