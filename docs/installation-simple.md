# 极简安装版 — telegram-async-return

给普通使用者的最短说明，只回答 4 个问题：

1. 插件怎么装
2. 装完怎么看有没有加载
3. 为什么“装好了”还可能没自动回传
4. 最稳的验收顺序是什么

## 先说最重要的一句

**安装成功，只表示插件已经进入 OpenClaw。**

它不等于下面这些能力已经全部打通：

- Telegram 长消息自动进入异步
- 任务完成后自动把结果补发回原聊天
- 发送失败后自动重试一定成功

这些还依赖 OpenClaw 宿主自己把发送接口、事件链路和异步判定策略接好。

## 最短安装步骤

### 1. 准备插件目录

如果你拿到的是源码目录，先构建：

```bash
npm install
npm run build
```

如果目录里已经有 `dist/`，这一步可以跳过。

### 2. 安装到 OpenClaw

```bash
openclaw plugins install /absolute/path/to/telegram-async-return
```

### 3. 在 OpenClaw 配置里启用

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
          "trackAllMessages": true,
          "webhookTimeoutMs": 30000
        }
      }
    }
  }
}
```

### 4. 重启 OpenClaw

让插件重新加载。

## 装完先看什么

### 先看插件有没有被发现

```bash
openclaw plugins list
```

应该能看到：

- `telegram-async-return`

如果日志可见，通常还会出现：

```text
[telegram-async-return] registering plugin
```

### 再看健康检查

优先执行：

```text
/async-return health
```

如果能正常返回，说明插件命令已经注册成功。

典型输出类似：

```text
enabled=true store=.openclaw/telegram-async-return/store.db sendAdapter=ok hooks=[gatewayStart] contracts=[inbound:ok,agent:unseen,outbound:unseen,deliverySignal:host_send_ack] classification=time_based wm=[init:true,agentEnd:false,msgSent:false,probeExpired:false] recent=0 latest=none
```

重点只看这几个字段：

- `enabled=true`
  说明插件已启用
- `sendAdapter=ok`
  说明宿主已经提供发送接口，自动补发更有机会成功
- `sendAdapter=none`
  说明插件能追踪任务，但自动补发链路还没打通。可设置环境变量 `TELEGRAM_BOT_TOKEN` 快速解决
- `hooks=[...]`
  说明哪些 hook 实际触发过，可用于判断事件链路有没有跑起来
- `classification=time_based`
  说明当前分类模式。`time_based` 表示 `trackAllMessages` 已开启，所有消息都会被追踪
- `wm=[...]`
  WorkingMode 探测状态，显示插件对宿主事件能力的自动检测结果

## 为什么“装好了”还是可能没反应

最常见是 3 种情况。

### 1. 宿主没有提供发送接口

插件最终回传依赖发送能力。如果宿主没有提供 `api.sendMessage()` 或 `runtime.telegram.sendMessageTelegram`，任务可能停在：

- `waiting_delivery`
- `delivery_failed`

**快速解决**：设置环境变量 `TELEGRAM_BOT_TOKEN`，插件会自动通过 Telegram Bot API 直接发送。

### 2. 宿主事件没有接全

自动回传完整链路依赖这些事件至少有一组能触发：

- `message:received` / `message_received`
- `agent:end` / `agent_end`
- `message:sent` / `message_sent`

少任何一环，都可能导致任务卡在中间状态。

### 3. 普通 Telegram 文本的异步分类

从 1.0.15 开始，推荐开启 `trackAllMessages: true`（默认已开启）。开启后：

- 所有消息都会被追踪，但**不会立即发 ack**
- 在 `agent:end` 时根据响应耗时判断：超过 `webhookTimeoutMs`（默认 30 秒）才触发异步回传
- 快速响应的消息会被静默完成，用户无感知

如果 `trackAllMessages` 关闭，回退到旧逻辑——普通文本不会仅凭”内容比较长”就自动进入异步。要触发异步，需要满足下面之一：

- 消息上下文里有 `asyncReturn: true`
- 消息上下文里有 `tags: [“long-task”]`、`[“async”]` 或 `[“background”]`
- 把 `asyncTextLengthThreshold` 改成正数

所以如果 `trackAllMessages` 关闭且没有上述标记，没有看到”后台处理中”不一定是安装失败，也可能只是宿主没有把普通消息纳入异步分类。

## 最稳的验收顺序

1. 确认 `openclaw plugins list` 能看到插件
2. 确认 `/async-return health` 正常返回
3. 先用一条显式异步消息测试任务有没有被追踪
4. 再测试任务完成后能不能自动补发
5. 最后再测普通 Telegram 长文本会不会自动触发异步

## 给用户的最终说法

最稳的表述是：

> 安装成功表示插件已经加载到 OpenClaw；是否能对 Telegram 长任务实现“先确认、后补发”，还取决于 OpenClaw 是否已经提供发送接口、完成事件映射，并接入异步分类策略。
