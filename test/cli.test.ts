import { spawn, ChildProcess } from 'node:child_process';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// bin 薄壳入口（与 npm 安装后的 .bin shim 行为一致）
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'api-docs-mcp-server.cjs');

/** 测试用 OpenAPI 文档 */
const spec = {
	openapi: '3.0.0',
	info: { title: 'CLI 冒烟 API', version: '1.0.0' },
	paths: {
		'/pets': {
			get: {
				tags: ['pet'],
				summary: '获取宠物列表',
				responses: {
					200: {
						description: 'ok',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Pet' },
							},
						},
					},
				},
			},
		},
	},
	components: {
		schemas: {
			Pet: {
				type: 'object',
				properties: { id: { type: 'integer' }, name: { type: 'string' } },
			},
		},
	},
};

/** 极简 MCP stdio 客户端：按行（JSONL）读写子进程 stdin/stdout */
class McpStdioClient {
	private proc: ChildProcess;
	private buffer = '';
	private queue: Array<(msg: any) => void> = [];
	private nextId = 1;

	constructor(args: string[]) {
		this.proc = spawn(process.execPath, [CLI_PATH, ...args], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc.stdout!.on('data', (d: Buffer) => {
			this.buffer += d.toString('utf-8');
			let idx: number;
			while ((idx = this.buffer.indexOf('\n')) >= 0) {
				const line = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (!line) {
					continue;
				}
				const msg = JSON.parse(line);
				const resolver = this.queue.shift();
				resolver?.(msg);
			}
		});
		// 测试失败时输出 stderr 便于排查
		this.proc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[cli-stderr] ${d}`));
	}

	request(method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		const msg = { jsonrpc: '2.0', id, method, params };
		return new Promise(resolve => {
			this.queue.push(resp => resolve(resp));
			this.proc.stdin!.write(JSON.stringify(msg) + '\n');
		});
	}

	/** 发送无需响应的 notification */
	notify(method: string, params: unknown): void {
		this.proc.stdin!.write(
			JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
		);
	}

	close(): void {
		this.proc.kill();
	}
}

let specPath: string;

beforeAll(() => {
	specPath = path.join(os.tmpdir(), `api-docs-mcp-smoke-${Date.now()}.json`);
	fs.writeFileSync(specPath, JSON.stringify(spec));
});

afterAll(() => {
	fs.rmSync(specPath, { force: true });
});

describe('CLI（stdio 模式）', () => {
	it('--help 输出用法说明', async () => {
		const proc = spawn(process.execPath, [CLI_PATH, '--help']);
		const out = await new Promise<string>(resolve => {
			let text = '';
			proc.stdout!.on('data', (d: Buffer) => (text += d.toString()));
			proc.on('close', () => resolve(text));
		});
		expect(out).toContain('api-docs-mcp-server');
		expect(out).toContain('--source');
	});

	it('通过 --source 启动后 initialize / tools/list / tools/call 全流程可用', async () => {
		const client = new McpStdioClient([`--source=${specPath}`]);
		try {
			// 1. initialize
			const init = await client.request('initialize', {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: { name: 'vitest-cli', version: '1.0.0' },
			});
			expect(init.result.serverInfo.name).toBe('api-docs-mcp-server');
			expect(init.result.serverInfo.version).toBe('1.0.0');
			expect(init.result.capabilities.tools).toEqual({ listChanged: true });

			client.notify('notifications/initialized', {});

			// 2. tools/list
			const list = await client.request('tools/list', {});
			expect(list.result.tools).toHaveLength(5);
			const names = list.result.tools.map((t: any) => t.name);
			expect(names).toEqual([
				'get-spec-overview',
				'search-apis',
				'get-api-detail',
				'get-openapi-spec',
				'refresh-cache',
			]);

			// 3. tools/call get-spec-overview（用默认源）
			const overview = await client.request('tools/call', {
				name: 'get-spec-overview',
				arguments: {},
			});
			expect(overview.result.isError).toBeUndefined();
			const overviewText = overview.result.content[0].text;
			expect(overviewText).toContain('CLI 冒烟 API');
			const parsed = JSON.parse(overviewText);
			expect(parsed.totalOperations).toBe(1);

			// 4. tools/call get-api-detail（$ref 展开）
			const detail = await client.request('tools/call', {
				name: 'get-api-detail',
				arguments: { method: 'GET', path: '/pets' },
			});
			const detailObj = JSON.parse(detail.result.content[0].text);
			expect(detailObj.responses['200'].content['application/json'].schema.properties.name).toEqual(
				{ type: 'string' }
			);
		} finally {
			client.close();
		}
	});

	it('--name/--version 覆盖 server 元信息', async () => {
		const client = new McpStdioClient([
			`--source=${specPath}`,
			'--name=custom-name',
			'--version=9.9.9',
		]);
		try {
			const init = await client.request('initialize', {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: { name: 'vitest-cli', version: '1.0.0' },
			});
			expect(init.result.serverInfo.name).toBe('custom-name');
			expect(init.result.serverInfo.version).toBe('9.9.9');
		} finally {
			client.close();
		}
	});

	it('工具调用 source 参数覆盖 CLI 默认源', async () => {
		// CLI 不传 --source，工具调用时传 source
		const client = new McpStdioClient([]);
		try {
			const overview = await client.request('tools/call', {
				name: 'get-spec-overview',
				arguments: { source: specPath },
			});
			expect(overview.result.isError).toBeUndefined();
			expect(overview.result.content[0].text).toContain('CLI 冒烟 API');
		} finally {
			client.close();
		}
	});

	it('未传 source 且工具未传 source 时返回 isError 提示', async () => {
		const client = new McpStdioClient([]);
		try {
			const overview = await client.request('tools/call', {
				name: 'get-spec-overview',
				arguments: {},
			});
			expect(overview.result.isError).toBe(true);
			expect(overview.result.content[0].text).toContain('未指定文档源');
		} finally {
			client.close();
		}
	});
});
