# madoka-dsh-plugins

DeepSeek Harness 插件套件（monorepo，同节奏发布）：

| 插件 | 说明 |
|---|---|
| [madoka-dsh-git-check](madoka-dsh-git-check/) | 一键扫描、分类、审查并提交代码 |
| [madoka-dsh-opencode-go-session](madoka-dsh-opencode-go-session/) | OpenCode Go 会话亲和（x-opencode-session 请求头） |
| [madoka-dsh-microsoft-docs](madoka-dsh-microsoft-docs/) | Microsoft Learn MCP 开箱即用 |
| [madoka-dsh-github-mcp](madoka-dsh-github-mcp/) | GitHub 官方远端 MCP 开箱即用 |

## 统一版本（lockstep）

根 `package.json` 的 `version` 是**唯一真源**，四个包永远同号。发版只改一处：

```sh
npm install              # 根安装（workspaces 依赖提升，版本自动去重）
npm run check            # 四包 check 全跑（一把梭；开头自动验版本号齐不齐）
npm run version:bump -- patch   # 或 minor / major：升根号并同步四包
npm run version:sync     # 只同步（改了根号没跑 bump 时用）
npm run version:check    # 只验不改：任一包号与根号不一致就非零退出
```

`scripts/sync-versions.mjs` 是零依赖小脚本，只改 `version` 字段，
保持 2 空格 + 尾换行 + 键序不动。`precheck` 钩子让每次 `npm run check`
都先过版本门禁——号漂了连测试都跑不起来，漂移提交不进仓库。

## 发版固定流程

```sh
npm run version:bump -- patch  # 1. 定号（根+四包一起动）
npm run check                  # 2. 全绿（含版本门禁）
# 3. 提交（走 /commit 流程，只做本地 commit）
npm publish -w madoka-dsh-git-check -w madoka-dsh-opencode-go-session -w madoka-dsh-microsoft-docs -w madoka-dsh-github-mcp
# 4. 四包一次发完（工件独立，只是号齐了）
```

根与各包的 `package-lock.json` 全部忽略（见 `.gitignore`）；
用 `npm install` 按 pin 范围复现安装。

## 目录收录

插件市场卡片的作者简介只认社区目录（[dshget-data](https://github.com/bobby-sheng/dshget-data)），
包里的 `description` 写了也不会显示。收录步骤：发版 → 仓库打 `dsh-plugin` topic →
去 dshget-data 开 issue 附中英简介。平时用卡片上的「添加备注」自己写一行，效果一样。
