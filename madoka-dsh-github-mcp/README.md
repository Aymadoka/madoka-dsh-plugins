# madoka-dsh-github-mcp

> DSH 插件 — GitHub 官方远端 MCP（新版 hosted server）开箱即用

把 [GitHub 官方远端 MCP 服务器](https://github.com/github/github-mcp-server)封装成 DSH bundle：**安装本插件后，模型的工具列表里直接出现 `mcp__github__*` 工具，无需单独安装或配置 MCP**。用的是新版 GitHub 托管的远端服务（`https://api.githubcopilot.com/mcp/`），不是旧的本地 stdio/docker 版。

## 原理

纯配置 bundle，无代码。`cordis.patch.yml` 复用宿主自带的 `@deepseek-ai/dsh-mcp-client` 桥接远端 MCP 服务器（Streamable HTTP）。默认接默认 toolset（context、repos、issues、pull_requests、users，含远端独占的 Copilot 相关工具）；只想要只读，把 `url` 改成 `https://api.githubcopilot.com/mcp/readonly` 即可。

## 认证（必须做）

远端服务必须认证。本插件用 PAT（个人访问令牌），**token 明文不进任何文件**，只从环境变量 `GITHUB_PERSONAL_ACCESS_TOKEN` 读取：

1. 去 [新建 fine-grained PAT](https://github.com/settings/personal-access-tokens/new)，按需给权限（只读：Contents / Issues / Pull requests 选 Read-only；要开 issue、提 PR、推文件则给 Read and write），建议只勾你会让模型碰的仓库。
2. Windows 持久化（新开进程生效）：
   ```powershell
   setx GITHUB_PERSONAL_ACCESS_TOKEN "github_pat_..."
   ```
3. 完全重启 DSH Desktop（环境变量是启动时读的）。

没设变量时插件激活会明确报错（`failOnStartupError: true`），而不是静默缺工具——看到报错先检查变量名和重启。

## 安装

```sh
dsh plugin --profile <你的profile> add ./madoka-dsh-github-mcp
```

或在 DSH-Desktop 的插件管理界面安装。准确的安装语法以所用版本的 `dsh plugin --help` 为准。

安装并配好 token 后，随便问一个 GitHub 问题（例如“列一下我这个仓库最近的 5 个 open PR”），模型会自动调用 `mcp__github__*` 工具。

## 安全

- 永远不要把 token 写进补丁、文档或对话里；轮换/吊销去 PAT 设置页一点就行。
- 最小权限 + 定期轮换；出问题先吊销再查。

## 本地开发

```sh
npm install
npm run typecheck  # 类型检查
npm test           # 编译补丁校验测试并用 node:test 运行
npm run check      # typecheck + test
```

## 协议

MIT
