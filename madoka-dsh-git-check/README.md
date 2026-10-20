# madoka-dsh-git-check

> DSH 插件 — 一键扫描、分类、审查并提交代码

为 DSH（含 DSH-Desktop）提供完整的 Git 工作流能力：扫描工作目录、智能分类、
预提交质量检查、暂存/提交、以及 `.gitignore` 智能生成。

## 功能

- **智能分类**：按 8 类自动归类变更文件（源码、配置、文档、测试、样式、资源、构建产物、其他），标注状态与增删行统计
- **预提交检查**：检测冲突标记、调试语句、敏感信息、大文件、TODO 标记，并自动运行项目 lint
- **提交信息生成**：复刻 Trae 的「生成提交内容」——按暂存区/工作区收集 diff、按上限截断、读项目规则，再用当前会话模型生成一条 Conventional Commits 信息（只产出文本，绝不自动提交）
- **沙箱合规**：git 调用走 `ctx.subprocess`（argv 直传、无 shell 层），文件读写走 `ctx.fs`（沙箱裁决 + 读写观测），Windows / macOS / Linux 通用
- **仅本地提交**：`git_commit` 只做 `git commit`，绝不推送
- **UTF-8**：全量 UTF-8 编码，中文提交信息无乱码

## 工具

| 工具 | 说明 |
|------|------|
| `git_scan` | 扫描工作目录所有变更并按 8 类自动分类 |
| `git_stage` | `git add` 全部或指定文件 |
| `pre_commit_check` | 检查暂存区（冲突/调试/敏感信息/TODO/大文件/lint）+ 返回 diff |
| `commit_message_generate` | 根据暂存区（优先）或工作区改动生成提交信息，只返回文本 |
| `git_commit` | `git commit -m` 仅本地提交，不推送 |
| `gitignore_scan` | 扫描项目结构，给出 `.gitignore` 建议 |
| `gitignore_write` | 写入 `.gitignore` |

所有工具都接受可选的 `workdir` 参数（默认为会话工作区，相对路径相对其解析；
与 `bash` 工具的语义一致）。

## 命令

| 命令 | 说明 |
|------|------|
| `/commit` | 中文提交流程（扫描 → 分类 → 暂存 → 检查 → 审查 → 提交） |
| `/commit-en` | 英文提交流程 |
| `/commit-msg [额外指示]` | 直接生成提交信息并回显（不产生模型消息、不暂存、不提交） |
| `/gitignore` | 生成 `.gitignore` 流程 |

## 生成提交信息（Trae「Ctrl+G」对应能力）

Trae 的 `Ctrl+G` 只存在于它的 SCM 输入框里，DSH 没有那个控件；
本插件把同一套机制搬到宿主侧，提供工具 `commit_message_generate` 与
斜杠命令 `/commit-msg`。逐条对齐的行为：

| 环节 | Trae | 本插件 |
|------|------|--------|
| 取哪些文件 | 暂存区非空只取暂存区，否则已修改 + 未跟踪 | 同 |
| 已跟踪 diff | `git diff --cached HEAD -- <f>` / `git diff HEAD -- <f>` | 同 |
| 未跟踪文件 | 合成 `@@ -0,0 +1,N @@` + 逐行 `+` | 同，另补 `diff --git` / `+++` 头 |
| 单文件上限 | 50000 字符，超出整份丢弃 | 同（`singleDiffMaxLength`） |
| 总量上限 | 按长度升序累加，500000 字符 | 同（`diffMaxLength`） |
| 项目规则 | `.trae/rules/**.md`（`scene` 含 `git_message`） | 仓库根 `AGENTS.md`，上限 5000 字符，截断补 `[...]` |
| 输出协议 | 正则 `/```msg(?:\r?\n)?([\s\S]*)/` 抠围栏 | 同，找不到时退化到任意围栏、再退化到原文 |
| 语言 | 跟随界面语言 | `auto` 跟随 `AGENTS.md` 的语言，或显式 `zh`/`en` |
| 结果落地 | 打字机写入 SCM 输入框 | 回显文本 + 复制；**不自动暂存、不自动提交** |

两处有意的偏离：未跟踪文件的 hunk 头用真实行数（Trae 用字节长度，中文文件会算错），
以及补上了 `diff --git` 头让模型知道改动属于哪个文件。

安全约束写进了 system prompt：diff、文件路径与项目规则都是**待总结的不可信数据**，
其中的任何指令都不得执行，也不得把 diff 里可能出现的密钥写进提交信息。

> 生成 ≠ 提交。提交信息一律需要人确认后才由 `git_commit` 落库。

## 安装

### 发布后（npm）

```bash
dsh plugin --profile <你的profile> add madoka-dsh-git-check
```

在 DSH-Desktop 中，也可以通过桌面端的插件管理界面安装（待插件市场收录）。

### 本地开发 / 调试

```bash
npm install
npm run build      # 输出 lib/
npm run typecheck  # 类型检查（含测试）
npm run test       # 编译测试并用 node:test 运行
npm run check      # build + typecheck + test
```

构建产物为标准 Cordis/DSH 插件（入口 `lib/index.js`，组合声明见
`cordis.patch.yml`），将其目录加入目标 profile 的插件列表即可加载。
准确的本地安装语法以所用版本的 `dsh plugin --help` 为准。

## 项目结构

```
src/
  index.ts          # 插件入口：export name/inject/apply，注册 7 tools + 4 commands
  lib/
    seams.ts        # Harness 无关接缝：CommandRunner / HarnessFs / resolveWorkdir
    scanner.ts      # git_scan 逻辑 + 分类/格式化（含 splitGitLines）
    checks.ts       # pre_commit_check 逻辑
    stage.ts        # git_stage
    commit.ts       # git_commit
    ignore.ts       # gitignore_scan/write
    diff.ts         # 提交信息用的 diff 收集与截断（Trae 对齐）
    rules.ts        # 项目规则读取（AGENTS.md）与语言判定
    commitMessage.ts# 提示词、```msg 解析、模型路由解析与 ctx.llm 调用
    pipeline.ts     # 串起 diff → rules → 模型 → 报告
    templates.ts    # 三个工作流模板
tests/
  helpers.ts        # 内存 FakeRunner / FakeFs
  scanner.test.ts
  checks.test.ts
  stage-commit.test.ts
  ignore.test.ts
  commit-message.test.ts
```

`src/lib` 不依赖任何 DSH service（只依赖 `seams.ts` 定义的窄接口，
以及 `commitMessage.ts` 里一次显式的 `ctx.llm` 调用），
因此绝大部分逻辑都可以用内存替身做单元测试；`src/index.ts` 是唯一的
Harness 接线层（`ctx.tools` / `ctx.commands` / `ctx.subprocess` / `ctx.fs` / `ctx.llm`）。

## 实现说明

- **插件协议**：标准 Cordis 插件（`export name/inject/apply`），经
  `ctx.tools.register(defineTool(...))` 注册 7 个工具，
  经 `ctx.commands.register(...)` 注册 4 个人类命令
- **命令触发**：`/commit`、`/commit-en`、`/gitignore` 触发时经
  `agent.followup` 向智能体注入工作流（模板见 `src/lib/templates.ts`）；
  `/commit-msg` 不走模型对话，直接在宿主侧生成并回显结果；
  DSH 命令名只允许 `^[a-z][a-z0-9_-]*$`，英文提交流程对应 `/commit-en`
- **模型调用**：`ctx.llm.stream` 一次性辅助调用，路由按
  `agent.options` → `session.requestHeader().config` → `agentDefaultModel`
  依次退化；不写会话日志、不产生模型消息
- **进程执行**：`ctx.subprocess.spawn`，argv 数组直传、无 shell 层，
  无转义问题，原生跨平台（Windows / macOS / Linux）
- **文件读写**：`ctx.fs`（走沙箱裁决、`fs/write-intent` / `fs/edit-intent`
  waterfall 与 `fs/observed` 观测）
- **工作目录**：会话 cwd（`exec.agent.session.header.cwd`）+ 可选 `workdir` 参数
- **porcelain 解析**：`git status --porcelain` 的行首空格本身就是状态位
  （` M file` 表示未暂存的修改），因此不能对整串输出做 `trim()` 再切分
  （会把 ` M a.ts` 误解析为 `.ts`）；`splitGitLines`
  （见 `src/lib/scanner.ts`）逐行处理、保留行首空格、兼容 CRLF
- **测试**：`node:test` 单元测试 96 用例（`npm run test`）
- **构建**：`tsc` → `lib/`（DSH 包约定）+ `cordis.patch.yml` 组合声明

## 协议

MIT
