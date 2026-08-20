/**
 * api-docs-mcp-server CLI 逻辑（stdio 模式）
 *
 * 本模块导出 run()，由 bin/api-docs-mcp-server.cjs 薄壳调用（参考 prettier 结构）。
 * 也可在代码中编程调用：import { run } from 'api-docs-mcp-server/cli'
 *
 * 供 Agent 智能体（Claude Code / Cursor 等）通过 mcpServers 配置直接拉取运行：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "api-server": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "api-docs-mcp-server@latest", "--source=https://xxx.com/v2/api-docs"]
 *     }
 *   }
 * }
 * ```
 *
 * 注意：stdio 模式下 stdout 是 JSON-RPC 协议通道，日志一律写入 stderr。
 */
import { startStdioServer } from './stdio-server';

/** CLI 解析结果 */
export interface CliOptions {
	source?: string;
	name?: string;
	version?: string;
}

const HELP_TEXT = `api-docs-mcp-server - 将 OpenAPI/Swagger 接口文档暴露为 MCP 工具

用法:
  npx -y api-docs-mcp-server@latest [选项]

选项:
  --source=<url|path>   默认文档源（Swagger/OpenAPI 文档的 URL 或本地文件路径）
                        工具调用时传 source 参数可覆盖此默认值
  --name=<name>         MCP server 名称（默认 api-docs-mcp-server）
  --version=<version>   MCP server 版本号（默认跟随包版本）
  -h, --help            显示此帮助

示例:
  npx -y api-docs-mcp-server@latest --source=https://petstore.swagger.io/v2/swagger.json
  npx -y api-docs-mcp-server@latest --source=./docs/openapi.yaml --name=my-api

通过 mcpServers 配置接入:
  {
    "mcpServers": {
      "api-server": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "api-docs-mcp-server@latest", "--source=https://xxx.com/v2/api-docs"]
      }
    }
  }
`;

/** 解析命令行参数（支持 --key=value 与 --key value 两种形式） */
export function parseArgs(argv: string[]): CliOptions | null {
	const options: CliOptions = {};
	const next = (i: number, key: keyof CliOptions): number => {
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--')) {
			console.error(`参数缺失: 需要为 --${key} 提供值`);
			return i;
		}
		options[key] = value;
		return i + 1;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			console.log(HELP_TEXT);
			return null;
		}
		if (arg.startsWith('--source=')) {
			options.source = arg.slice('--source='.length);
		} else if (arg === '--source') {
			i = next(i, 'source');
		} else if (arg.startsWith('--name=')) {
			options.name = arg.slice('--name='.length);
		} else if (arg === '--name') {
			i = next(i, 'name');
		} else if (arg.startsWith('--version=')) {
			options.version = arg.slice('--version='.length);
		} else if (arg === '--version') {
			i = next(i, 'version');
		} else {
			console.error(`未知参数: ${arg}（使用 --help 查看帮助）`);
			process.exit(1);
		}
	}
	return options;
}

/** CLI 主逻辑：解析参数 → 启动 stdio MCP server → 注册信号优雅退出 */
export function run(): void {
	let options: CliOptions | null;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (e: any) {
		console.error(`api-docs-mcp-server 启动失败: ${e?.message ?? e}`);
		process.exit(1);
	}
	if (options === null) {
		process.exit(0); // --help 已输出
	}

	startStdioServer({
		defaultSource: options.source,
		serverInfo: {
			name: options.name,
			version: options.version,
		},
	})
		.then(handle => {
			// 优雅退出
			let shuttingDown = false;
			const shutdown = async (): Promise<void> => {
				if (shuttingDown) {
					return;
				}
				shuttingDown = true;
				await handle.close();
				process.exit(0);
			};
			process.on('SIGINT', () => void shutdown());
			process.on('SIGTERM', () => void shutdown());
			process.on('SIGBREAK', () => void shutdown());
		})
		.catch((e: any) => {
			console.error(`api-docs-mcp-server 启动失败: ${e?.message ?? e}`);
			process.exit(1);
		});
}
