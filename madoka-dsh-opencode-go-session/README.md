# madoka-dsh-opencode-go-session

DSH 插件，只面向 OpenCode Go，两件事：

1. 给 OpenCode Go 请求自动附加**每会话稳定**的 `x-opencode-session` 请求头，修复 `400 MissingSessionID`，保持会话亲和与提示缓存路由。
2. 让 `deepseek-v4.1-flash` 可用，且排在 `opencode-go` 组第一位（引擎自带目录里没有它）。

> 范围：只要 OpenCode Go。不要 `opencode`，不要 Command Code。
> 加头模式与 `dsh-opencode-session` 一致：默认 `session-id`。

## 安装

```sh
dsh plugin --profile web add ./E:/PrivateCode/madoka-dsh-opencode-go-session
# bundle 层只在启动时读，改完必须完全重启
```

本地开发：

```sh
npm install
npm run build      # 输出 lib/（含 .d.ts）
npm run typecheck  # 类型检查（含测试）
npm test           # 编译测试并用 node:test 运行
npm run check      # build + typecheck + test
```

## 两个半边，能力不同（务必先读）

| 半边 | 实现的通道 | 依赖 | DSH Desktop 0.1.7 |
|---|---|---|---|
| 加头 | `llm/stream` + `AsyncLocalStorage` + 包裹 `globalThis.fetch` | 仅 `llm` 服务 | ✅ 正常工作 |
| 模型供给 | 目录补丁脚本（见下） | 应用安装目录可写 | ✅ 跑一次脚本+重启即生效 |

### 为什么不用“运行时写 settings”，也不用“profile 里声明路由”

DSH Desktop 0.1.7 的宿主**没有实现 settings 服务**，日志原话：

```
[dsh-market] this host's settings service has no register()
             (dsh 0.1.7 derives settings from a plugin Config schema)
```

而 profile 里声明路由那条路我们**实测走不通还伤及无辜**：引擎按
`api = route.api ?? catalogModel.api`、`baseUrl = route.baseURL ?? catalogModel.baseUrl` 解析，
**路由级的值会盖掉每个模型自带的目录值**。`opencode-go` 横跨三种协议加两个 `baseUrl`
（`/zen/go` 与 `/zen/go/v1`），给路由加 `api`/`baseURL` 会把全部模型按一种协议处理，
当场打坏 6 个（`minimax-m3`、`qwen3.8-flash`、`muse-spark-1.3/1.2-contributor`、
`gpt-5.6-luna`、`grok-4.6`，`UNKNOWN_MODEL`）；模型条目级又**不支持** `api`/`baseURL`，
且 `dsh-llm` 只暴露 `discoverModels`、没有注册模型的口子。所以唯一的正门是**把 flash
写进引擎自带目录**——新条目自带自己的 `api`/`baseUrl`，谁也不盖谁。

## DSH Desktop 部署：跑脚本补目录

```sh
node scripts/apply-catalog-patch.mjs --dry-run   # 先看会发生什么
node scripts/apply-catalog-patch.mjs             # 真写：备份 .bak 后插入条目
```

* 脚本默认指向本机 DSH Desktop 的 pi-ai 目录：`.../resources/app/node_modules/@earendil-works/pi-ai`
  下的 `dist/providers/data/opencode-go.json`；位置不同用 `--root <pi-ai 包目录>`。
* 幂等：已存在则直接报 `already in the catalog`，不会重复插入。
* 插入位置是第一组第一个键——`flattenModelCatalog` 就是 `Object.assign` 打平，
  顺序即插入顺序，所以 flash 会排在 `opencode-go` 组第一位。
* 条目与同目录的 `deepseek-v4-flash` 逐字对齐（含 `compat` 与思考档位），`manifest`
  的哈希运行时不校验（只用了 `generatedAt`），可以放心改。
* **DSH Desktop 每次更新都会还原这个文件**——更新后重跑一次脚本即可。

改完**完全重启** DSH Desktop；profile 里 `opencode-go` 只需要 `apiKeyEnv`，**不要**
再加 `api`/`baseURL`/`models`（见上节原因）。插件 `providers` 保持默认 `['opencode-go']`。

## 确认生效

* 模型选择器里 `opencode-go` 组的**第一项**是 `DeepSeek V4.1 Flash`。
* 原来 27 个模型全部照旧可用（切任一个验证；`muse-spark-1.3-contributor` 必须能用）。
* 启动日志出现：`[opencode-go] active for providers [opencode-go] with mode session-id`。
* 多轮对话不再 `400 MissingSessionID`。

## 配置（插件行 `config`，全可选）

| 键 | 说明 |
|---|---|
| `providers` | 默认 `['opencode-go']`，自定义同端点别名才加 |
| `mode` | 默认 `'session-id'`，备选 `'uuid'`（每会话随机 UUID，不发送内部会话 ID） |
| `debug` | `true` 打每条加头日志 |
| `debugFile` | 绝对路径，追加 JSON 行 |

## 加头半边的行为

* 只监听 `llm/stream`，`options.provider` 命中 `providers` 且有 `sessionId` 才进入
  `AsyncLocalStorage` 窗口，窗口内 `globalThis.fetch` 自动加头；请求已带该头时让路。
* 并发会话各持各的值；插件卸载/更新时恢复原始 `fetch`。

## 已知限制

* 宿主若换掉 Node 全局 `fetch`，加头会失效（症状：`400` 回归）。
* 目录补丁在 DSH Desktop 更新后需重打（脚本幂等，可直接重跑）。
* 上游改了目录结构（比如换了数据文件名）导致脚本找不到锚点时，它会拒绝写入并报错，
  不会留下半份文件——那时按报错信息更新脚本即可。

## 许可

MIT
