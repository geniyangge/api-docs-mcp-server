#!/usr/bin/env node
"use strict";
/**
 * api-docs-mcp-server CLI 薄壳入口（参考 prettier 的 bin/ 结构）
 * 实际逻辑在 src/cli.ts（编译为 dist/cli.js），此处仅负责调用其 run()
 *
 * 供 Agent 智能体（Claude Code / Cursor 等）通过 mcpServers 配置直接拉取运行：
 * {
 *   "mcpServers": {
 *     "api-server": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "api-docs-mcp-server@latest", "--source=https://xxx.com/v2/api-docs"]
 *     }
 *   }
 * }
 */
require("../dist/cli.js").run();
