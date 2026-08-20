# api-docs-mcp-server

将 OpenAPI / Swagger 接口文档暴露为 **MCP (Model Context Protocol) 工具** 的服务端。

框架无关（零 NestJS / 框架依赖），提供两种接入形态：

- **stdio 模式（CLI）**：`npx -y api-docs-mcp-server@latest --source=...`，免安装直接拉起，供 Agent 智能体（Claude Code / Cursor / 其他 MCP 客户端）通过 `mcpServers` 配置使用
- **HTTP 模式**：`createMcpHttpHandler` Express 中间件 / 原生 Node http，自托管服务，供远程 MCP 客户端连接

## 特性

- **5 个 MCP 工具**：概览 / 搜索 / 详情 / 全量导出 / 刷新缓存
- **双规范支持**：OpenAPI 3.x 与 Swagger 2.0（自动归一化为 3.x 视图）
- **$ref 递归展开**：接口详情中数据模型引用直接展开为可读结构（循环引用标记 `$ref-cycle`）
- **多数据源**：URL 下载或本地文件（`.json` / `.yaml` / `.yml`），20MB 上限
- **内置缓存**：TTL 5 分钟、LRU 最多 10 个源，支持手动强制刷新（失败保留旧缓存）
- **可注入依赖**：自定义 axios 实例 / logger / 缓存参数

## 安装

要求 Node >= 18。

```bash
npm install api-docs-mcp-server
```

> 终端用户无需安装：通过 `npx -y api-docs-mcp-server@latest` 免安装直接运行（`@latest` 保持最新版）。

## 快速开始

按使用场景二选一：

| 场景 | 推荐形态 |
| --- | --- |
| 本地 Agent（Claude Code / Cursor）直接接入 | **stdio 模式** |
| 自托管服务，供远程 MCP 客户端调用 | **HTTP 模式** |

### 完整示例：使用一个 OpenAPI 文档链接

以一个真实的 OpenAPI 文档链接为例，走一遍从接入到调用的完整流程。

**1. 准备文档链接**

以 Petstore 官方 OpenAPI 文档为例（其他任意 `.json` / `.yaml` / `.yml` 链接同理）：

```
https://petstore.swagger.io/v2/swagger.json
```

**2. 接入 Agent（Claude Code / Cursor）**

将链接作为默认文档源配置到 `mcpServers`：

```json
{
  "mcpServers": {
    "petstore": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "api-docs-mcp-server@latest",
        "--source=https://petstore.swagger.io/v2/swagger.json"
      ]
    }
  }
}
```

**3. 在对话中直接使用**

配置完成后，Agent 即可基于该文档链接调用 MCP 工具：

| 用户提问 | Agent 触发的工具 | 返回结果 |
| --- | --- | --- |
| 「这份文档里有哪些接口？」 | `get-spec-overview` | 接口总数、tags 分组统计 |
| 「查找用户登录的接口」 | `search-apis`（关键词 `login`） | 匹配的 path / summary / operationId |
| 「查看创建宠物接口的详细参数」 | `get-api-detail`（method=`POST`、path=`/pet`） | 参数说明与 $ref 展开后的数据模型 |

> 临时切换文档：调用工具时传入 `source` 参数即可覆盖默认链接，如 `{"source": "https://another.example.com/openapi.json"}`。

### 方式一：stdio 模式（推荐，Agent 智能体接入）

无需安装到本地，直接通过 `npx` 拉起（`@latest` 保持最新版）：

```bash
# 默认文档源为 URL
npx -y api-docs-mcp-server@latest --source=https://petstore.swagger.io/v2/swagger.json

# 或本地文件
npx -y api-docs-mcp-server@latest --source=./docs/openapi.yaml

# 自定义 server 名称/版本
npx -y api-docs-mcp-server@latest --source=https://xxx.com/v2/api-docs --name=my-api
```

在 Cursor / Claude Code 的 `mcpServers` 配置中添加：

```json
{
  "mcpServers": {
    "api-server": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "api-docs-mcp-server@latest",
        "--source=https://xxx.com/v2/api-docs"
      ]
    }
  }
}
```

> 说明：工具调用时也可通过 `source` 参数传入其他文档地址（优先级高于 CLI 的 `--source` 默认值）。

#### CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--source=<url\|path>` | 默认文档源（URL 或本地文件路径） |
| `--name=<name>` | MCP server 名称（默认 `api-docs-mcp-server`） |
| `--version=<version>` | MCP server 版本号（默认 `1.0.0`） |
| `-h, --help` | 显示帮助 |

### 方式二：HTTP 模式（自托管服务）

#### Express

```ts
import express from 'express';
import { createMcpHttpHandler } from 'api-docs-mcp-server';

const app = express();
app.use(express.json()); // 交给 MCP 处理器前先解析 JSON body

app.use(
	'/mcp',
	createMcpHttpHandler({
		defaultSource: 'https://petstore.swagger.io/v2/swagger.json', // 可选
	})
);

app.listen(3000);
// MCP 端点: http://localhost:3000/mcp
```

#### 原生 Node http

```ts
import { createServer } from 'node:http';
import { createMcpHttpHandler } from 'api-docs-mcp-server';

const handler = createMcpHttpHandler(); // 无需 express.json()，内部自动解析 body

createServer(async (req, res) => {
	await handler(req, res);
}).listen(3000);
```

HTTP 模式下文档源可通过以下方式指定（优先级从高到低）：

1. **工具调用参数** `source`（如 `{"source": "https://.../openapi.json"}`）
2. **请求 URL 查询参数** `?source=<文档地址>`
3. **请求头** `x-mcp-source: <文档地址>`
4. **服务端默认源** `createMcpHttpHandler({ defaultSource })`

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `get-spec-overview` | 文档概览：info / servers / tags 分组统计 / 接口总数 |
| `search-apis` | 按关键词搜索接口（匹配 path / summary / description / tags / operationId） |
| `get-api-detail` | 按 method + path 返回接口详情，$ref 递归展开 |
| `get-openapi-spec` | 导出完整/分段文档（format: json/yaml, section: full/paths/schemas/info） |
| `refresh-cache` | 强制刷新文档缓存（传 source 刷新单源，不传刷新全部缓存源） |

## 配置项

### `createMcpHttpHandler(options)`

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `defaultSource` | `string` | - | 服务端默认文档源 |
| `service` | `OpenapiService` | 自动创建 | 自定义服务实例（共享缓存 / 注入测试替身） |
| `logger` | `LoggerLike` | `console` | 日志器 |
| `maxBodySize` | `number` | 10MB | HTTP 请求体大小上限（字节） |
| `serverInfo` | `{ name?, version? }` | `api-docs-mcp-server` | MCP 客户端看到的 server 元信息 |

### `new OpenapiService(options)`

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `axiosInstance` | `AxiosInstance` | `axios` | 自定义 axios 实例（代理 / 拦截器 / 测试） |
| `logger` | `LoggerLike` | `console` | 日志器 |
| `maxSpecSize` | `number` | 20MB | 单个 spec 文件大小上限（字节） |
| `cacheTtlMs` | `number` | 5 分钟 | 缓存有效期 |
| `cacheLimit` | `number` | 10 | 最多缓存的数据源数量（LRU） |

### `startStdioServer(options)`

库内嵌启动 stdio 模式 MCP server（与 CLI 同款逻辑，日志自动走 stderr）：

```ts
import { startStdioServer } from 'api-docs-mcp-server';

const handle = await startStdioServer({
	defaultSource: 'https://.../openapi.json',
	serverInfo: { name: 'my-server' },
});
// 进程退出前调用 handle.close() 优雅关闭
```

### `createMcpServer(service, options)`

底层 API，直接构造注册好工具的 `McpServer`（可配合 `StdioServerTransport` / `SSEServerTransport` 等任意传输使用）：

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, OpenapiService } from 'api-docs-mcp-server';

const service = new OpenapiService({ defaultSource: 'https://.../openapi.json' });
const server = createMcpServer(service, { defaultSource: 'https://.../openapi.json' });
await server.connect(new StdioServerTransport());
```

## 错误处理

所有文档源错误统一为 [`McpSourceError`](src/service/errors.ts)，携带机器可读的 `kind` 分类：

- `SOURCE_NOT_SPECIFIED` / `DOWNLOAD_FAILED` / `FILE_READ_FAILED` / `INVALID_EXTENSION` / `FILE_TOO_LARGE`
- `INVALID_DOCUMENT` / `UNSUPPORTED_METHOD` / `PATH_NOT_FOUND` / `METHOD_NOT_FOUND`
- `BODY_TOO_LARGE` / `BODY_PARSE_FAILED`

MCP 工具调用失败时以 `isError: true` 返回错误文本，HTTP 层错误返回 JSON-RPC 错误格式。

## 与 NestJS 的适配

本包不依赖 NestJS。在 NestJS 项目中接入只需一步：

```ts
// mcp.controller.ts
import { Controller, Post, Req, Res } from '@nestjs/common';
import { createMcpHttpHandler } from 'api-docs-mcp-server';

@Controller('mcp')
export class McpController {
	@Post()
	async handle(@Req() req, @Res() res) {
		await createMcpHttpHandler({ defaultSource: '...' })(req, res);
	}
}
```

> 注意：Nest 路由层需要禁用 `ValidationPipe` 对 MCP 请求体的校验（该端点的 body 是 JSON-RPC 消息，不是业务 DTO）。

## License

MIT
