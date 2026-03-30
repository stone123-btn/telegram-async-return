# OpenClaw 集成指南 — telegram-async-return

本文档供 OpenClaw 运行时环境参考，说明本插件对宿主环境的依赖、事件契约、发送层要求，以及集成验证方法。

---

## 插件注册

插件通过标准 OpenClaw 插件接口注册：

```typescript
register(api: OpenClawPluginApi) {
  api.registerService(service);
  api.registerCommand(command);
  api.on(eventName, handler);
}
```

注册时使用的接口：

| 接口 | 用途 | 是否必须 |
|------|------|---------|
| `api.on(event, handler)` | 监听生命周期事件 | 必须 |
| `api.registerService(service)` | 注册任务追踪服务 | 必须 |
| `api.registerCommand(command)` | 注册 `/async-return` 命令 | 必须 |
| `api.logger` | 日志输出 | 可选（缺失时静默） |
| `api.runtime` | 运行时对象（用于存储 scheduler 实例和 hook 活动） | 可选 |
| `api.resolvePath(input)` | 路径解析（用于 storePath） | 可选 |
| `api.sendMessage(msg)` | 发送消息到用户 | 可选（见下方发送层说明） |
| `api.pluginConfig` | 插件配置对象 | 可选（缺失时使用默认配置） |

---

## 发送层

### 接口定义

```typescript
sendMessage?: (msg: {
  chatId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;
```

### 可用性

插件会按以下优先级解析发送能力：

1. **`api.sendMessage()`** - 优先使用
2. **`api.runtime.telegram.sendMessageTelegram`** - OpenClaw runtime fallback
3. **`config.telegramBotToken`** 或环境变量 **`TELEGRAM_BOT_TOKEN`** - 插件自带，通过 fetch 直调 Telegram Bot API
4. **无发送能力** - 仅追踪，不发送

### 缺失时的行为

若所有发送接口都不存在：

1. 插件正常注册，基础追踪功能不受影响
2. 首次调用 delivery 时记录 `warn` 日志：`no supported send adapter available (adapter=none)`
3. delivery 返回 `false`，任务标记为 `delivery_failed`
4. scheduler 会根据配置重试，但重试同样失败
5. 不会抛出异常或导致插件崩溃

### 适配指南

若当前环境不提供任何发送接口但需要自动回传：

**方式 A（最简单）：设置环境变量**

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
```

或在插件配置中：

```jsonc
{
  "telegramBotToken": "123456:ABC-DEF..."
}
```

插件会通过 `fetch` 直接调用 `https://api.telegram.org/bot<token>/sendMessage`。

**方式 B：注入 api.sendMessage**

```typescript
api.sendMessage = async (msg) => {
  await telegramBot.sendMessage(msg.chatId, msg.text);
};
```

**方式 C：通过 runtime.telegram 注入**

```typescript
api.runtime.telegram = {
  sendMessageTelegram: async (chatId, text, metadata) => {
    await telegramBot.sendMessage(chatId, text);
  }
};
```

---

## 事件契约

### 注册的事件

插件注册以下事件 handler，同时注册多种命名格式：

| 事件 | 注册的名称 | handler |
|------|-----------|---------|
| 网关启动 | `gateway:startup`、`gateway_start` | 初始化 scheduler、执行启动恢复 |
| 网关关闭 | `gateway:shutdown`、`gateway_shutdown`、`gateway_stop` | 停止 scheduler |
| 收到消息 | `message:received`、`message_received` | 识别长任务、创建追踪记录 |
| 消息已发送 | `message:sent`、`message_sent` | 确认投递成功或记录投递失败 |
| Agent 结束 | `agent:end`、`agent_end` | 标记任务完成、触发投递 |

### 事件字段兼容提取

以下不是宿主必须严格满足的固定 TypeScript shape，而是插件 normalize 时优先尝试提取的字段。

**message:received**

```typescript
context / metadata: {
  channel?: string;         // 或 channelId / provider / surface
  chatId?: string;          // 或 conversationId / to / from
  threadId?: string;
  sessionId?: string;
  sessionKey?: string;
  messageId?: string;       // 用于去重
  text?: string;            // 或 content
  tags?: string[];          // "long-task"/"async"/"background"
  asyncReturn?: boolean;    // 显式标记为异步任务
  reply?: (text: string) => Promise<void>;
}
```

**message:sent**

```typescript
context / metadata: {
  channel?: string;
  chatId?: string;
  taskId?: string;      // 最佳情况，强关联
  kind?: string;        // "delivery_failed" 时标记投递失败
  error?: string;
  source?: string;      // 若显式为其他来源则跳过
  metadata?: Record<string, unknown>;
}
```

**agent:end**

```typescript
context / metadata: {
  taskId?: string;      // 最佳情况，强关联
  chatId?: string;      // 弱关联兜底
  sessionId?: string;   // 推荐提供
  sessionKey?: string;  // 备用兜底
  status?: string;
  success?: boolean;
  error?: string;
  resultSummary?: string;
  resultPayload?: unknown;
  messages?: unknown[]; // 可用于提取最后一条 assistant 文本
}
```

**重要**：若 `agent:end` 中 `taskId`、`chatId`、`sessionId`、`sessionKey` 全部缺失，插件无法关联到已追踪任务，会记录 contract mismatch 日志并跳过。

### context 防御性处理

插件不再直接假定固定 hook shape，而是先对原始宿主事件做 normalize：

- 宽松读取 `event.context`、`event.metadata`、`event.sessionKey` 等字段
- 尝试提取标准化的 `channel/chatId/sessionId/sessionKey/taskId/resultSummary`
- 若宿主缺少显式字段，会降级为弱关联，而不是直接崩溃
- 若 normalize 或关联失败，会记录 contract mismatch 日志

### 幂等保证

若 OpenClaw 同时触发多种格式事件（如 `gateway:startup` 和 `gateway_start`），handler 会执行多次。插件通过以下机制保证幂等：

- 任务状态机转换有前置状态检查
- 去重窗口内相同 chatId + promptHash 复用任务
- scheduler 启动有 `_running` 标志防重入
- `inFlight` 标志防止 scheduler tick 并发

---

## 状态机

```
queued → running → waiting_delivery → delivering → sent_confirmed
                        ↓                ↓
                      failed       delivery_failed
```

### 各状态转换的触发条件

| 转换 | 触发者 |
|------|-------|
| → `queued` | `message:received` handler 创建任务 |
| `queued` → `running` | `message:received` handler 调用 `startTask` |
| `running` → `waiting_delivery` | `agent:end` handler 调用 `completeTask` |
| `running` → `failed` | `agent:end` handler，status 为 failed/error 或有 error |
| `waiting_delivery` → `delivering` | scheduler 或手动 `resendTask` |
| `delivering` → `sent_confirmed` | `message:sent` handler 或 scheduler 确认宿主发送层成功 |
| `delivering` → `delivery_failed` | `message:sent` handler（kind=delivery_failed）或 deliver 返回 false |

---

## 健康检查

### 命令

```
/async-return health
```

### 输出格式

```
enabled=<bool> store=<path> sendAdapter=<kind> hooks=[<fired hooks>] contracts=[inbound:<state>,agent:<state>,outbound:<state>,deliverySignal:host_send_ack] classification=<mode> wm=[init:<bool>,agentEnd:<bool>,msgSent:<bool>,probeExpired:<bool>] recent=<n> latest=<task:state|none>
```

### data 字段

```json
{
  "ok": true,
  "enabled": true,
  "storePath": "...",
  "runtimeBin": "...",
  "sendAdapter": "api.sendMessage",
  "contractHealth": {
    "inboundNormalization": "ok",
    "agentCompletionCorrelation": "weak",
    "outboundCorrelation": "unseen",
    "classification": "time_based",
    "deliverySignal": "host_send_ack",
    "sendAdapter": "api.sendMessage"
  },
  "classification": "time_based",
  "workingMode": {
    "initialized": true,
    "hasAgentEnd": true,
    "hasMessageSent": false,
    "probeExpired": false,
    "eventFormat": {
      "hasContext": true,
      "hasMetadata": true,
      "chatIdPath": "context.chatId",
      "sessionKeyPath": "event.sessionKey",
      "textPath": "context.text",
      "channelPath": "context.channel"
    }
  },
  "recentTrackedTasks": 1,
  "latestTask": {
    "taskId": "chat-123-abc",
    "state": "running"
  },
  "hookActivity": {
    "gatewayStart": true,
    "gatewayStop": false,
    "messageReceived": true,
    "messageSent": false,
    "agentEnd": true
  }
}
```

`hookActivity` 为 `null` 表示 runtime 不可用，无法追踪。

`contractHealth` 字段说明：

- `inboundNormalization`：入站消息是否能被标准化
- `agentCompletionCorrelation`：`agent:end` 是否能稳定关联回已追踪任务
- `outboundCorrelation`：`message:sent` 是否能稳定关联到待投递任务
- `classification`：当前异步识别模式（`time_based` 表示 trackAllMessages 已开启）

`workingMode` 字段说明（1.0.15 新增）：

- `initialized`：是否已收到首条 Telegram 消息并完成初始化
- `hasAgentEnd`：是否已探测到 `agent:end` 事件能力
- `hasMessageSent`：是否已探测到 `message:sent` 事件能力
- `probeExpired`：探测窗口（`probeWindowMs`）是否已过期
- `eventFormat`：首条消息的事件格式指纹，包含 `chatIdPath`、`sessionKeyPath`、`textPath`、`channelPath` 等字段路径

---

## 集成验证步骤

### 1. 确认插件加载

日志中出现：

```
[telegram-async-return] registering plugin
```

### 2. 确认基础能力

```
/async-return health
→ enabled=true
```

### 3. 确认发送层

```
/async-return health
→ sendAdapter=api.sendMessage                        # 使用 api.sendMessage
→ sendAdapter=runtime.telegram.sendMessageTelegram   # 使用 runtime fallback
→ sendAdapter=config.telegramBotToken                # 使用 bot token 直调 Telegram API
→ sendAdapter=none                                   # 不可用，需适配
```

### 4. 确认事件链路

发送测试消息后检查 health 输出中的 hooks 列表：

- `messageReceived` 应出现 → `message:received` 或 `message_received` 已触发
- `agentEnd` 应出现 → `agent:end` 或 `agent_end` 已触发
- `messageSent` 应出现 → `message:sent` 或 `message_sent` 已触发

若某个 hook 始终不出现，表示对应事件在当前环境中未触发或命名不匹配。

### 5. 验证完整状态机

发送 `asyncReturn: true` 测试消息，跟踪任务状态：

```
/async-return status --chat <test-chat-id> --latest
```

预期流转：`queued` → `running` → `waiting_delivery` → `delivering` → `sent_confirmed`

若 `trackAllMessages: true`（1.0.15 默认），所有消息都会被追踪，分类模式为 `time_based`，无需显式标记即可触发异步回传（根据 agent 响应耗时自动判断）。

若 `trackAllMessages: false` 且 `asyncTextLengthThreshold=0`，普通 Telegram 文本不会自动进入异步链路；测试时应显式带上 `asyncReturn: true`、异步标签或宿主侧业务标记。

若停在某个状态，参考 README 中的故障判断表。

---

## 故障排查

| 现象 | 层级 | 原因 | 处理 |
|------|------|------|------|
| 插件未加载 | 注册层 | 配置未引入插件 | 检查 openclaw.config.json |
| `sendAdapter=none` | 发送层 | 环境不提供任何发送接口且未配置 bot token | 设置环境变量 `TELEGRAM_BOT_TOKEN` 或配置 `telegramBotToken` |
| 任务停在 `running` | agent_end 层 | agent:end 未触发或字段不匹配 | 检查 OpenClaw agent 完成事件 |
| 任务停在 `waiting_delivery` | 发送层 | sendAdapter 不可用 | 适配发送层或手动 resend |
| 任务停在 `delivering` | hook 层 | message:sent 未触发 | 检查 OpenClaw 消息发送事件 |
| 任务停在 `delivery_failed` | 发送层 | 发送接口调用失败 | 检查发送接口实现 |
| `hooks=[none]` | hook 层 | 无事件触发 | 检查事件名格式匹配 |
| `contracts=[inbound:missing,...]` | 入站层 | message_received shape 无法 normalize | 检查 context / metadata 字段 |
| `contracts=[agent:weak,...]` | agent_end 层 | 只能用 session/chat 弱关联 | 尽量稳定提供 taskId |
| `contracts=[outbound:weak,...]` | message_sent 层 | 缺少 taskId，只能按 chatId 弱关联 | 尽量让发送事件带 taskId |
| sent_confirmed 但用户未收到 | hook 层 | message_sent 语义不等于 Telegram 实际收到 | 检查 message_sent 触发时机 |

---

## 配置参考

详细配置说明参见 [README.md](../README.md#配置说明)。

关键配置项对集成的影响：

| 配置项 | 默认值 | 集成影响 |
|--------|--------|---------|
| `trackAllMessages` | `true` | 开启后所有消息自动追踪，分类模式为 `time_based`，根据 agent 响应耗时决定是否异步回传 |
| `webhookTimeoutMs` | `30000` | `trackAllMessages` 开启时，agent 响应超过此阈值才触发异步回传 |
| `maxTaskWaitMs` | `300000` | 任务最大等待时间（毫秒），超时后标记为失败 |
| `probeWindowMs` | `60000` | WorkingMode 能力探测窗口（毫秒），探测 agentEnd/messageSent 是否可用 |
| `cleanupCompletedInline` | `true` | 快速完成的任务（trackAll 分类）是否在 agent_end 时直接清理 |
| `completedInlineRetentionMs` | `300000` | 已内联完成的任务保留时间（毫秒），过期后清理 |
| `asyncTextLengthThreshold` | `0` | `trackAllMessages` 关闭时生效，为 0 时仅依赖显式标记 |
| `classification.keywordTriggers` | `[]` | 可用关键词触发异步分类，便于测试和宿主适配 |
| `classification.acceptPlainLongText` | `false` | 显式允许普通文本走兜底分类，默认关闭 |
| `autoResendOnDeliveryFailure` | `true` | 发送层不可用时建议设为 false |
| `recovery.scanOnStartup` | `true` | 依赖 gateway:startup hook |
| `ackOnAsyncStart` | `true` | 依赖 message:received 的 reply 回调。`trackAllMessages` 开启时，trackAll 分类的消息会延迟到 agent_end 再决定是否发 ack |
