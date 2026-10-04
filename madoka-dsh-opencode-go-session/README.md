# madoka-dsh-opencode-go-session

DSH 插件，只面向 OpenCode Go，只做一件事：

给 OpenCode Go 请求自动附加**每会话稳定**的 `x-opencode-session` 请求头，修复 `400 MissingSessionID`，保持会话亲和与提示缓存路由。

> 范围：只要 OpenCode Go。不要 `opencode`，不要 Command Code。
> 加头模式与 `dsh-opencode-session` 一致：默认 `session-id`。

## 安装

```sh
dsh plugin --profile <你的profile> add ./madoka-dsh-opencode-go-session
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

## 确认生效

* 启动日志出现：`[opencode-go] active for providers [opencode-go] with mode session-id`。
* 多轮对话不再 `400 MissingSessionID`。

## 配置（插件行 `config`，全可选）

| 键 | 说明 |
|---|---|
| `providers` | 默认 `['opencode-go']`，自定义同端点别名才加 |
| `mode` | 默认 `'session-id'`，备选 `'uuid'`（每会话随机 UUID，不发送内部会话 ID） |
| `debug` | `true` 打每条加头日志 |
| `debugFile` | 绝对路径，追加 JSON 行 |

## 加头行为

* 只监听 `llm/stream`，`options.provider` 命中 `providers` 且有 `sessionId` 才进入
  `AsyncLocalStorage` 窗口，窗口内 `globalThis.fetch` 自动加头；请求已带该头时让路。
* 并发会话各持各的值；插件卸载/更新时恢复原始 `fetch`。

## 已知限制

* 宿主若换掉 Node 全局 `fetch`，加头会失效（症状：`400` 回归）。

## 许可

MIT
