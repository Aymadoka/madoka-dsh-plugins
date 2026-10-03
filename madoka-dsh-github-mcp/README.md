# madoka-dsh-github-mcp

> DSH 插件 — GitHub 官方远端 MCP（新版 hosted server）开箱即用

把 [GitHub 官方远端 MCP 服务器](https://github.com/github/github-mcp-server)封装成 DSH bundle：**安装本插件后，模型的工具列表里直接出现 `mcp__github__*` 工具，无需单独安装或配置 MCP**。用的是新版 GitHub 托管的远端服务（`https://api.githubcopilot.com/mcp/`），不是旧的本地 stdio/docker 版。

## 原理

纯配置 bundle，无代码。`cordis.patch.yml` 复用宿主自带的 `@deepseek-ai/dsh-mcp-client` 桥接远端 MCP 服务器（Streamable HTTP）。默认接默认 toolset（context、repos、issues、pull_requests、users，含远端独占的 Copilot 相关工具）；只想要只读，把 `url` 改成 `https://api.githubcopilot.com/mcp/readonly` 即可。

## 认证

远端服务必须认证，用 PAT（个人访问令牌）。两种方式，**任选其一**：

### 方式一：环境变量（推荐）

`Authorization` 默认用 Loader `!!js` 引用环境变量，token 不落盘：

1. 去 [新建 fine-grained PAT](https://github.com/settings/personal-access-tokens/new)，按需给权限（只读：Contents / Issues / Pull requests 选 Read-only；要开 issue、提 PR、推文件则给 Read and write），建议只勾你会让模型碰的仓库。
2. Windows 持久化（新开进程生效），两种写法任选其一：
   ```powershell
   setx GITHUB_PERSONAL_ACCESS_TOKEN "github_pat_..."
   # 或 PowerShell 原生写法（作用相同：写入 User 级环境变量）：
   [Environment]::SetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN', 'github_pat_...', 'User')
   ```
   验证是否写成功（会打印值，请勿外传）：
   ```powershell
   [Environment]::GetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN', 'User')
   ```
3. 完全重启 DSH Desktop（环境变量是启动时读的；托盘退出、确认无残留进程后从开始菜单重开，应用内重启不更新 OS 环境）。

### 方式二：profile 覆盖行

在你自己的 profile 补丁里加一行**同 id 覆盖行**。按 Loader 规则，同 id 的覆盖行会**整体替换**本插件默认行的 `config`，因此覆盖行里要写完整配置：

```yaml
- id: madoka-github-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: 'Bearer github_pat_...'
    failOnStartupError: true
```

**优先级**：覆盖行 > 环境变量 > 都没有（`failOnStartupError: true` 会明确报错，而不是静默缺工具）。

注意：同一行里不能写 `config.token` 这类“自己引用自己”的 `!!js`——Loader 的 `!!js` 在 Loader 作用域求值，看不到本行 config；桥接的 schema 也会丢弃未知字段。跨行覆盖才是正道。

> 说明：曾尝试在此 bundle 内加浏览器 token 表单（`plugins.row.config`），实测宿主不给桥接行发表单对象（`form` 恒为 `undefined`），此路在此版本走不通，已回退。首 token 走环境变量。

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
