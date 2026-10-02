# madoka-dsh-microsoft-docs

> DSH 插件 — Microsoft Learn MCP 开箱即用

把微软官方的 [Microsoft Learn MCP 服务器](https://learn.microsoft.com/en-us/training/support/mcp)封装成 DSH bundle：**安装本插件后，模型的工具列表里直接出现微软文档工具，无需单独安装或配置 MCP**。

## 原理

纯配置 bundle，无代码。`cordis.patch.yml` 复用宿主自带的 `@deepseek-ai/dsh-mcp-client` 桥接远端 MCP 服务器（Streamable HTTP，免认证）：

```yaml
- insert:
    - id: madoka-microsoft-docs
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: microsoft-docs
        transport: streamable-http
        url: https://learn.microsoft.com/api/mcp
        failOnStartupError: true
```

## 可用工具

| 工具 | 说明 |
|------|------|
| `mcp__microsoft-docs__microsoft_docs_search` | 搜索微软官方文档 |
| `mcp__microsoft-docs__microsoft_docs_fetch` | 拉取完整文档文章 |
| `mcp__microsoft-docs__microsoft_code_sample_search` | 搜索代码示例 |

工具列表由服务端下发、可能随上游变化；连不上服务端时插件激活会明确报错（`failOnStartupError: true`），而不是静默缺工具。

## 安装

```sh
dsh plugin --profile <你的profile> add ./madoka-dsh-microsoft-docs
```

或在 DSH-Desktop 的插件管理界面安装。准确的安装语法以所用版本的 `dsh plugin --help` 为准。

安装后随便问一个微软技术问题（例如“用 C# 写个 minimal API hello world”），模型会自动调用上面的工具。

## 条款与限制

- 使用该 MCP 即表示同意 [Microsoft Learn 使用条款](https://learn.microsoft.com/en-us/legal/termsofuse)；无需认证、免费。
- 只覆盖公开发布的文档，不含培训或用户画像信息；知识库每天全量刷新一次。

## 本地开发

```sh
npm install
npm run typecheck  # 类型检查
npm test           # 编译补丁校验测试并用 node:test 运行
npm run check      # typecheck + test
```

## 协议

MIT
