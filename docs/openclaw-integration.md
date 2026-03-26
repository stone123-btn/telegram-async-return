# OpenClaw 集成指南 — telegram-async-return

本文档供 OpenClaw 运行时环境参考，说明本插件对宿主环境的依赖、事件契约、发送层要求，以及集成验证方法。

---

## 宿主责任边界

插件层只负责：

- 追踪 Telegram 长任务
- 维护任务状态机
- 提供 `/async-return` 命令、诊断、repair、resend
- 在宿主已经提供发送能力时调用发送接口

OpenClaw 宿主负责：

- 暴露 `api.sendMessage()` 或等效发送桥接
- 保证插件监听的事件实际会触发
- 保证 `event.context` 字段满足契约
- 决定哪些普通 Telegram 消息进入异步链路
- 处理 CLI 是否可直接执行

如果部署目标是“任务完成后自动把结果回写到 Telegram”，那么以下能力都应视为**关键平台契约**，而不是插件自己的可选增强：

- `agent:end` 必须稳定提供足够的关联字段
- `api.sendMessage()` 必须稳定可用
- `message:sent` 的语义必须被宿主明确定义
- 若需要独立 CLI，宿主或安装器必须显式暴露执行入口

不要把“插件已安装”解释成“宿主已完成适配”。这是两个阶段。

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
| `api.sendMessage(msg)` | 发送消息到用户 | 基础追踪可缺失；自动回传场景必须稳定提供 |
| `api.pluginConfig` | 插件配置对象 | 可选（缺失时使用默认配置） |

---

## 发送层（api.sendMessage）

### 接口定义

```typescript
sendMessage?: (msg: {
  chatId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;
```

### 可用性

**`api.sendMessage()` 并非所有 OpenClaw 环境都提供。**

- 部分 OpenClaw 版本/分支提供此接口
- 插件在注册时检测该接口是否存在，并在 health 命令中报告
- 在 delivery 时通过 `typeof sendMessage === "function"` 动态检测
- 对“异步结果自动回传”这个目标而言，它应被视为关键平台契约，而不是可选特性

### 缺失时的行为

若 `api.sendMessage()` 不存在：

1. 插件正常注册，基础追踪功能不受影响
2. 首次调用 delivery 时记录 `warn` 日志：`api.sendMessage is not available`
3. delivery 返回 `false`，任务标记为 `delivery_failed`
4. scheduler 会根据配置重试，但重试同样失败
5. 不会抛出异常或导致插件崩溃

### 适配指南

若当前环境不提供 `api.sendMessage()` 但需要自动回传，有两种适配路径：

**方式 A：在 OpenClaw 宿主中注入**

```typescript
// 在 plugin api 构造时注入
api.sendMessage = async (msg) => {
  await telegramBot.sendMessage(msg.chatId, msg.text);
};
```

**方式 B：通过 runtime 间接注入**

```typescript
// 在 runtime 上注册，插件自行读取
api.runtime.sendMessage = async (msg) => { ... };
```

注意：插件当前只检查 `api.sendMessage`，不检查 `runtime.sendMessage`。方式 B 需要修改插件代码。

**推荐做法**：由 OpenClaw 在构造插件 API 时直接注入 `api.sendMessage()`。不要把发送适配责任交给插件在运行时猜测。

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

### 事件 context 字段要求

**message:received**

```typescript
context: {
  channel: string;      // 必须为 "telegram" 才处理
  chatId: string;       // 用于关联任务
  threadId?: string;
  sessionId?: string;
  messageId?: string;   // 用于去重
  text?: string;        // 用于文本长度检测（若启用）
  tags?: string[];      // 用于标签识别（"long-task"/"async"/"background"）
  asyncReturn?: boolean; // 显式标记为异步任务
  reply?: (text: string) => Promise<void>; // 用于发送 ack
}
```

补充说明：

- 若 `channel !== "telegram"`，插件会直接跳过
- 若既没有 `asyncReturn`、也没有匹配 `tags`、且 `asyncTextLengthThreshold === 0`，插件会把这条消息视为普通消息并跳过
- 因此“普通 Telegram 长文本自动异步化”必须由 OpenClaw 自己负责策略接入

**message:sent**

```typescript
context: {
  channel: string;      // 必须为 "telegram" 才处理
  taskId?: string;      // 关联已追踪任务
  kind?: string;        // "delivery_failed" 时标记投递失败
  error?: string;       // 错误描述
  source?: string;      // 事件来源（若非本插件发出则跳过）
  metadata?: Record<string, unknown>;
}
```

补充说明：

- 插件当前把 `message:sent` 当作发送成功确认
- 但这个确认默认只是**宿主发送层语义**
- 若宿主里的 `message:sent` 只表示“已提交发送队列”，那么插件里的 `sent_confirmed` 也只能理解为“发送层已确认”，不能理解为“Telegram 客户端已收到”

**agent:end**

```typescript
context: {
  taskId?: string;      // 关联已追踪任务
  chatId?: string;      // 备选关联方式
  sessionId?: string;   // 备选关联方式
  status?: string;      // "failed"/"error" 视为失败
  error?: string;
  resultSummary?: string;
  resultPayload?: unknown;
}
```

**重要**：若 `agent:end` 的 context 中 `taskId`、`chatId`、`sessionId` 全部缺失，插件无法关联到已追踪任务，会记录 debug 日志并跳过。

建议宿主至少做到：

- 稳定暴露 `taskId`
- 在无法提供 `taskId` 时，稳定暴露 `chatId` 或 `sessionId`
- 在成功完成时提供 `resultSummary` 或 `resultPayload`

### context 防御性处理

插件对所有 event.context 做防御性处理：

- 若 `context` 为 `undefined` 或 `null`，handler 直接跳过并记录 debug 日志
- 不会因 context 字段缺失而抛出异常
- 所有字段按可选处理

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

`sent_confirmed` 在当前实现中的准确含义是：**插件观察到宿主发送成功事件**。它不是端到端的 Telegram 用户可见性保证。

---

## 健康检查

### 命令

```
/async-return health
```

### 输出格式

```
enabled=<bool> store=<path> sendMessage=<ok|missing> hooks=[<fired hooks>] contracts=[agentEndIdentifiers:<status>,messageSentTaskId:<status>,deliverySignal:host_send_ack]
```

### data 字段

```json
{
  "ok": true,
  "enabled": true,
  "storePath": "...",
  "runtimeBin": "...",
  "sendMessageAvailable": true,
  "hookActivity": {
    "gatewayStart": true,
    "gatewayStop": false,
    "messageReceived": true,
    "messageSent": false,
    "agentEnd": false
  }
}
```

`hookActivity` 为 `null` 表示 runtime 不可用，无法追踪。

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

这一步只表示插件层已加载，不表示自动回传链路已经打通。

### 3. 确认发送层

```
/async-return health
→ sendMessage=ok     # 可用
→ sendMessage=missing # 不可用，需适配
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

若停在某个状态，参考 README 中的故障判断表。

如果你用普通 Telegram 文本做测试，则 OpenClaw 应先保证下面至少一项成立：

1. 为消息注入 `asyncReturn: true`
2. 为消息注入 `tags: ["long-task"]` / `["async"]` / `["background"]`
3. 把 `asyncTextLengthThreshold` 调整为正数

否则“没有进入异步”是符合当前契约的。

---

## 故障排查

| 现象 | 层级 | 原因 | 处理 |
|------|------|------|------|
| 插件未加载 | 注册层 | 配置未引入插件 | 检查 openclaw.config.json |
| `sendMessage=missing` | 发送层 | 环境不提供 api.sendMessage | 适配发送层 |
| 普通长消息没有触发 ack | 分类层 | OpenClaw 未注入异步标记，且阈值为 0 | 由 OpenClaw 接入异步分类策略 |
| 任务停在 `running` | agent_end 层 | agent:end 未触发或字段不匹配 | 检查 OpenClaw agent 完成事件 |
| 任务停在 `waiting_delivery` | 发送层 | sendMessage 不可用 | 适配发送层或手动 resend |
| 任务停在 `delivering` | hook 层 | message:sent 未触发 | 检查 OpenClaw 消息发送事件 |
| 任务停在 `delivery_failed` | 发送层 | sendMessage 调用失败 | 检查发送接口实现 |
| `hooks=[none]` | hook 层 | 无事件触发 | 检查事件名格式匹配 |
| sent_confirmed 但用户未收到 | hook 层 | message_sent 语义不等于 Telegram 实际收到 | 检查 message_sent 触发时机 |

---

## 配置参考

详细配置说明参见 [README.md](../README.md#配置说明)。

关键配置项对集成的影响：

| 配置项 | 默认值 | 集成影响 |
|--------|--------|---------|
| `asyncTextLengthThreshold` | `0` | 为 0 时仅依赖显式标记，不自动判定 |
| `autoResendOnDeliveryFailure` | `true` | 发送层不可用时建议设为 false |
| `recovery.scanOnStartup` | `true` | 依赖 gateway:startup hook |
| `ackOnAsyncStart` | `true` | 依赖 message:received 的 reply 回调 |

---

## 对 OpenClaw 的建议

若希望终端用户获得“直接发 Telegram 长任务即可自动补发结果”的体验，OpenClaw 最好自己提供一个稳定的宿主适配层：

1. 统一发送桥接到 `api.sendMessage()`
2. 统一事件名与 `context` 字段
3. 统一长任务判定策略，而不是让每个插件自己猜
4. 把 CLI 暴露问题交给安装器/宿主处理，而不是要求用户手工找二进制

这样插件文档就可以把“安装”与“宿主适配”明确分开，避免对最终用户过度承诺。
