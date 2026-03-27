# 安装说明 — telegram-async-return

这份文档面向 OpenClaw 使用者，目标是把 3 件事拆开说清楚：

1. 插件已经安装
2. 插件已经加载
3. OpenClaw 宿主已经完成适配，自动回传真正可用

这三件事不是一回事。

## 它负责什么，不负责什么

`telegram-async-return` 是一个 OpenClaw 插件，负责：

- 追踪 Telegram 长任务
- 维护任务状态
- 提供 `/async-return` 命令
- 在宿主提供发送能力时，尝试把最终结果补发回 Telegram

它不负责替 OpenClaw 自动补齐宿主能力。

OpenClaw 宿主仍需要自己负责：

- 提供发送接口，例如 `api.sendMessage()`
- 触发插件监听的事件链路
- 决定哪些普通 Telegram 消息应该进入异步
- 决定是否给运维侧暴露独立 CLI

## 适用场景

适合你遇到这类问题：

- Telegram webhook 很快结束，但长任务还没跑完
- 用户重复追问“刚才那个结果呢”
- 你希望先给用户确认消息，结果出来后再补发回原聊天

## 前置条件

安装前请先确认：

- OpenClaw 已正常运行
- Telegram 渠道已启用
- 你可以修改 OpenClaw 配置并重启 Gateway

如果你拿到的是源码仓库，还需要：

- Node.js
- npm

## 推荐安装方式

### 方式 A：从本地目录安装

这是最稳妥的方式，适合本地开发、联调或私有部署。

如果目录是源码，先构建：

```bash
npm install
npm run build
```

然后安装到 OpenClaw：

```bash
openclaw plugins install /absolute/path/to/telegram-async-return
```

如果你当前就在插件目录，也可以直接用：

```bash
openclaw plugins install "$(pwd)"
```

### 方式 B：先拉仓库，再按路径安装

```bash
git clone <your-repo-url> telegram-async-return
cd telegram-async-return
npm install
npm run build
openclaw plugins install "$(pwd)"
```

### 关于 npm 包安装

这个包的包名是：

```text
@openclaw/telegram-async-return
```

但是否能直接通过 `npm install` 后由 OpenClaw 自动发现，取决于你当前使用的 OpenClaw 发行版、插件加载策略和部署方式。

如果你不确定，优先使用上面的“按目录安装”方式，不要把包管理方式和插件加载方式混为一谈。

## 启用插件

推荐在 OpenClaw 配置里显式启用：

```jsonc
{
  "plugins": {
    "entries": {
      "telegram-async-return": {
        "enabled": true,
        "config": {
          "enabled": true,
          "ackOnAsyncStart": true,
          "ackTemplate": "已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。",
          "asyncTextLengthThreshold": 0,
          "autoResendOnDeliveryFailure": true,
          "recovery": {
            "enabled": true,
            "scanOnStartup": true,
            "maxRecoveryTasks": 100
          },
          "dedupe": {
            "enabled": true,
            "promptHash": true,
            "replyToMessage": true,
            "windowSeconds": 900
          }
        }
      }
    }
  }
}
```

改完配置后，重启 OpenClaw Gateway。

## 安装完成后怎么验证

### 第 1 步：确认插件被发现

```bash
openclaw plugins list
```

应能看到：

- `telegram-async-return`

日志里通常还会看到：

```text
[telegram-async-return] registering plugin
```

这一步只说明：**插件层已经装上了。**

### 第 2 步：确认插件已经加载

优先执行：

```text
/async-return health
```

如果能正常返回，说明插件命令、服务和基础注册链路已经可用。

典型输出类似：

```text
enabled=true store=.openclaw/telegram-async-return/store.db sendMessage=ok hooks=[gatewayStart] contracts=[agentEndIdentifiers:unseen,messageSentTaskId:unseen,deliverySignal:host_send_ack]
```

字段含义如下：

- `enabled=true`
  插件已启用
- `store=...`
  SQLite 状态库路径
- `sendMessage=ok`
  宿主已提供发送接口，自动回传更有可能正常工作
- `sendMessage=missing`
  宿主没有提供发送接口且未配置 bot token，插件可以追踪任务，但自动回传不能保证。可设置环境变量 `TELEGRAM_BOT_TOKEN` 快速解决
- `hooks=[gatewayStart,...]`
  表示哪些 hook 已经实际触发过
- `hooks=[none]`
  还没有任何 hook 被触发
- `hooks=unknown`
  当前 runtime 无法记录 hook 活动

### 第 3 步：先测显式异步消息

不要一上来就拿普通聊天消息测试。

先发送一条带显式异步标记的测试消息，再执行：

```text
/async-return status --chat <chat-id> --latest
```

这一步主要验证：

- 插件能不能创建任务
- 任务能不能进入 `queued` / `running`
- 去重和状态查询是否正常

### 第 4 步：验证完整回传链路

如果宿主适配完整，状态通常会经历：

```text
queued -> running -> waiting_delivery -> delivering -> sent_confirmed
```

如果执行完成但没自动回传，继续查：

```text
/async-return diagnose --chat <chat-id>
```

需要手动补发时可用：

```text
/async-return resend --task <task-id>
```

## 为什么“装好了”也可能没有自动回传

这是最容易误解的地方。

### 原因 1：宿主没有提供发送接口

插件最终回传依赖发送能力，按优先级依次尝试：

1. `api.sendMessage()`
2. `runtime.telegram.sendMessageTelegram`
3. 插件配置 `telegramBotToken` 或环境变量 `TELEGRAM_BOT_TOKEN`

如果以上都不可用：

- 插件仍可追踪任务
- `/async-return` 命令仍可用
- 但任务可能停在 `waiting_delivery` 或 `delivery_failed`

**最快的解决方式**：设置环境变量 `TELEGRAM_BOT_TOKEN`，插件会自动通过 Telegram Bot API 直接发送消息。

### 原因 2：事件链路没接全

插件会监听下面这些事件名：

- `gateway:startup` / `gateway_start`
- `gateway:shutdown` / `gateway_shutdown` / `gateway_stop`
- `message:received` / `message_received`
- `message:sent` / `message_sent`
- `agent:end` / `agent_end`

如果 `message:received`、`agent:end`、`message:sent` 里任何一环没有实际触发，自动回传链路都可能断在中间。

常见表现是：

- 卡在 `running`
  往往表示 `agent:end` 没触发或字段不匹配
- 卡在 `waiting_delivery`
  往往表示发送接口不可用，或完成后还没进入投递
- 卡在 `delivering`
  往往表示 `message:sent` 没触发，导致无法确认已送达

### 原因 3：普通 Telegram 文本默认不会自动进入异步

默认配置是：

```jsonc
{
  "asyncTextLengthThreshold": 0
}
```

这意味着：

- 普通 Telegram 文本不会仅因为“很长”就自动进入异步

要进入异步，宿主至少要满足下面之一：

- 给消息上下文设置 `asyncReturn: true`
- 给消息上下文设置 `tags: ["long-task"]`、`["async"]` 或 `["background"]`
- 把 `asyncTextLengthThreshold` 改成正数

所以“没有先回后台处理中”不一定是安装失败，也可能只是宿主没有接入普通消息自动异步化策略。

## 推荐验收流程

按下面顺序最稳：

1. 安装插件
2. 启用配置
3. 重启 Gateway
4. 执行 `/async-return health`
5. 先发送一条显式异步测试消息
6. 确认状态至少能走到 `running`
7. 再确认是否能走到 `sent_confirmed`
8. 最后再测试普通 Telegram 长消息

## 常见故障判断

| 现象 | 更可能的问题 | 建议先查什么 |
|------|-------------|-------------|
| `/async-return health` 执行失败 | 插件未加载或命令未注册 | `plugins list`、启动日志 |
| `sendMessage=missing` | 宿主未提供发送接口且未配置 bot token | 设置环境变量 `TELEGRAM_BOT_TOKEN` 或在插件 config 中配置 `telegramBotToken` |
| 任务停在 `running` | `agent:end` 未触发或字段不匹配 | agent 完成事件及其 `context` |
| 任务停在 `waiting_delivery` | 执行完成了，但发送层不可用或未开始投递 | `sendMessage` 状态、诊断结果 |
| 任务停在 `delivering` | `message:sent` 未触发 | Telegram 发送完成事件 |
| `delivery_failed` | 发送接口失败或返回异常 | 发送层实现、warn 日志 |
| 普通长文本完全不触发异步 | 没有异步分类策略 | `asyncReturn`、`tags`、`asyncTextLengthThreshold` |

## `/async-return` 和独立 CLI 的区别

优先级更高的是：

```text
/async-return health
```

因为它走的是插件命令注册链路。

独立 CLI：

```bash
openclaw-telegram-async-return health
```

是否能直接在 shell 执行，还取决于：

- 安装器是否暴露了 bin
- `PATH` 是否包含对应目录
- 你的宿主部署是否希望对运维侧暴露独立命令

所以：

- `plugins list` 能看到插件
- `/async-return health` 能正常执行

这两个信号通常比“shell 里能不能直接敲 CLI”更重要。

## 一句话总结

最稳的判断标准是：

- `openclaw plugins install ...` 成功：插件已安装
- `/async-return health` 正常：插件已加载
- 显式异步测试任务能走到 `sent_confirmed`：宿主适配已打通
