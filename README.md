# @openclaw/telegram-async-return

OpenClaw 插件 —— Telegram 长任务异步结果追踪与回传。

## 项目说明

用户在 Telegram 发起长任务时，webhook 等待窗口先于任务完成而关闭，导致最终结果无法回传，用户误以为任务失败并重复追问。

本插件提供任务追踪、状态管理、诊断修复能力。**自动回传能力取决于当前 OpenClaw 环境是否提供发送接口和完整的事件钩子链路。**

## 设计目标

- 在任何支持 `api.on()` / `api.registerService()` / `api.registerCommand()` 的 OpenClaw 环境中提供**基础追踪能力**
- 在发送接口和事件钩子完整的环境中提供**自动回传能力**
- 帮助使用者快速判断问题出在 hook 层、agent_end 层还是发送层
- 不夸大兼容性，不默认所有环境都能自动补发结果

## 兼容性说明

插件功能按环境依赖分为三层。部署后必须验证当前环境实际支持哪一层。

### 第一层：基础追踪能力

**依赖**：`api.on()`、`api.registerService()`、`api.registerCommand()`

所有支持插件注册的 OpenClaw 环境均可使用：

- 注册命令（`/async-return`）
- 记录任务（SQLite 持久化）
- 状态查询（`status` / `recent`）
- 诊断与修复（`diagnose` / `repair` / `resend`）

此层不依赖发送接口，不依赖特定事件钩子。任务追踪、去重、状态管理均可正常工作。

### 第二层：自动回传能力

**额外依赖**：

- **可用发送接口**：`api.sendMessage()` 或等效发送适配层
- **`agent:end` / `agent_end` 事件**：通知插件任务已完成
- **`message:sent` / `message_sent` 事件**：确认消息已投递到 Telegram

缺少以上任一依赖，插件仍可追踪任务，但：

- 若无发送接口 → 任务停在 `waiting_delivery` 或 `delivery_failed`，无法自动补发
- 若无 `agent:end` → 任务停在 `running`，不会触发结果投递
- 若无 `message:sent` → 任务停在 `delivering`，无法确认投递成功

### 第三层：重试与恢复能力

**额外依赖**：

- **启动/关闭 hook**：`gateway:startup` / `gateway_start`、`gateway:shutdown` / `gateway_shutdown` / `gateway_stop`
- **delivery scheduler**：依赖启动 hook 初始化
- **数据库存储**：SQLite WAL 模式

缺少启动 hook → scheduler 不会自动启动，需手动触发重发。

## 功能分层说明

| 能力 | 第一层（基础） | 第二层（回传） | 第三层（恢复） |
|------|:-:|:-:|:-:|
| 命令注册 | Y | Y | Y |
| SQLite 持久化 | Y | Y | Y |
| status / recent / diagnose / repair | Y | Y | Y |
| 去重与任务复用 | Y | Y | Y |
| 自动确认回复（ack） | Y | Y | Y |
| 任务完成检测 | - | Y | Y |
| 结果自动回传 | - | Y | Y |
| 投递失败自动重试 | - | - | Y |
| 进程重启恢复 | - | - | Y |

## 安装

```bash
npm install @openclaw/telegram-async-return
```

在 OpenClaw 配置中引入：

```jsonc
// openclaw.config.json
{
  "plugins": ["@openclaw/telegram-async-return"]
}
```

## 配置说明

所有配置项均有默认值。以下重点说明需要关注的配置项。

### 完整配置示例

```jsonc
{
  "enabled": true,
  "storePath": ".openclaw/telegram-async-return/store.db",
  "ackOnAsyncStart": true,
  "ackTemplate": "已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。",
  "asyncTextLengthThreshold": 0,
  "autoResendOnDeliveryFailure": true,
  "resend": {
    "maxAttempts": 5,
    "minDelayMs": 1000,
    "maxDelayMs": 30000,
    "jitter": true
  },
  "recovery": {
    "enabled": true,
    "scanOnStartup": true
  },
  "dedupe": {
    "enabled": true,
    "promptHash": true,
    "replyToMessage": true,
    "windowSeconds": 900
  }
}
```

### asyncTextLengthThreshold

控制是否根据消息文本长度自动判定为长任务。

- **默认值 `0`**：禁用文本长度检测
- **初始部署建议设为 `0`**，不建议依赖文本长度自动判定
- 推荐优先使用显式触发条件：
  - `asyncReturn: true`（消息上下文标记）
  - `tags: ["long-task"]` / `tags: ["async"]` / `tags: ["background"]`
  - 业务层显式条件
- 设为正数（如 `120`）时，文本长度超过阈值的消息会被识别为长任务，但可能误判普通长消息

检测优先级：`asyncReturn` → `tags` → 文本长度（兜底）

### ackOnAsyncStart

- `true`（默认）：识别到长任务后立即回复确认消息
- 若识别规则过宽（如启用了文本长度检测且阈值过低），可能对普通消息误发确认提示
- 建议配合收紧的识别规则使用

### dedupe

去重适合处理用户重复追问场景。

- `windowSeconds`：去重时间窗口（默认 900 秒）
- 窗口太长可能导致用户的新请求被误复用为旧任务
- `promptHash`：基于消息内容哈希去重
- `replyToMessage`：基于回复的原消息 ID 去重

### autoResendOnDeliveryFailure

- `true`（默认）：投递失败后由 scheduler 自动重试
- **自动重试不等于一定能送达**：若发送接口不可用，重试只会持续失败直到达到 `maxAttempts`
- 若当前环境未适配发送层，建议设为 `false` 避免无效重试

## 事件钩子

插件同时注册多种格式的 hook 名称以兼容不同 OpenClaw 版本：

| 用途 | 注册的事件名 |
|------|-------------|
| 网关启动 | `gateway:startup`、`gateway_start` |
| 网关关闭 | `gateway:shutdown`、`gateway_shutdown`、`gateway_stop` |
| 收到消息 | `message:received`、`message_received` |
| 消息已发送 | `message:sent`、`message_sent` |
| Agent 结束 | `agent:end`、`agent_end` |

**幂等保证**：若 OpenClaw 同时触发多种格式事件，handler 会执行多次。插件内置去重和状态检查保证不会重复处理同一任务。

**不同环境差异**：

- 部分环境使用 `gateway_stop` 而非 `gateway_shutdown`
- 部分环境可能不触发 `message:sent`
- `agent:end` 事件的字段结构可能与插件预期不完全匹配

## 消息发送接口（api.sendMessage）

**并非所有 OpenClaw 环境都提供 `api.sendMessage()`。**

- 部分 OpenClaw 版本/分支提供此接口
- 若当前环境未提供，插件仍可进行任务追踪、状态管理、诊断和 repair
- 但异步结果自动回传不可保证，需要额外适配发送层
- 缺失发送接口时：
  - 记录 `warn` 级别日志
  - 投递返回 `false`
  - 任务进入 `waiting_delivery` 或 `delivery_failed` 状态
  - 不会抛出异常或导致插件崩溃

若需在不支持 `api.sendMessage()` 的环境中实现回传，需自行实现发送适配层并注入到 `api.sendMessage`。

## 验证安装

### 步骤 1：确认插件注册成功

启动日志中应看到：

```
[telegram-async-return] registering plugin
```

若未出现，检查插件是否正确引入到 OpenClaw 配置。

### 步骤 2：执行健康检查

```
/async-return health
```

输出示例：

```
enabled=true store=.openclaw/telegram-async-return/store.db sendMessage=ok hooks=[gatewayStart]
```

**输出字段解读**：

| 字段 | 含义 |
|------|------|
| `enabled=true` | 插件已启用 |
| `store=...` | SQLite 存储路径 |
| `sendMessage=ok` | `api.sendMessage()` 可用，自动回传有望正常工作 |
| `sendMessage=missing` | `api.sendMessage()` 不可用，自动回传将失败，需适配发送层 |
| `hooks=[gatewayStart,...]` | 已触发过的 hook 列表，用于判断事件链路是否畅通 |
| `hooks=unknown` | runtime 不可用，无法追踪 hook 活动 |
| `hooks=[none]` | 尚无任何 hook 被触发 |

### 步骤 3：验证任务追踪

发送一条带 `asyncReturn: true` 的测试消息，然后：

```
/async-return status --chat <chat-id> --latest
```

确认任务被创建且状态为 `queued` 或 `running`。

### 步骤 4：验证完整状态机流转

完整的状态机流转应经历：

```
queued → running → waiting_delivery → delivering → delivered
```

若任务停在某个中间状态，参考下方故障判断。

### 故障判断

| 现象 | 可能原因 | 排查方向 |
|------|---------|---------|
| 任务停在 `running` | `agent:end` / `agent_end` 未触发或字段不匹配 | 检查 OpenClaw 是否发出 agent_end 事件，检查事件 context 是否包含 taskId/chatId/sessionId |
| 任务停在 `waiting_delivery` | 发送接口不可用 | 检查 `sendMessage=ok/missing`，若 missing 需适配发送层 |
| 任务停在 `delivery_failed` | 发送接口调用失败或不可用 | 检查 warn 日志，确认发送接口实现是否正确 |
| 任务停在 `delivering` | `message:sent` / `message_sent` 未触发 | 检查 OpenClaw 是否发出 message_sent 事件 |
| `delivered` 但 Telegram 未收到 | `message:sent` 判定过早，实际消息未到达 Telegram | 检查 message_sent 事件语义是否表示 Telegram 实际已收到 |
| `sendMessage=missing` | 当前环境不提供 `api.sendMessage()` | 需实现发送适配层或使用提供该接口的 OpenClaw 版本 |
| `hooks=[none]` | 事件未触发或 hook 名格式不匹配 | 检查 OpenClaw 使用的事件名格式，确认插件注册的格式与之匹配 |

## 任务状态机

```
queued → running → waiting_delivery → delivering → delivered
                        ↓                ↓
                      failed       delivery_failed
```

## CLI 命令

```bash
# 健康检查
openclaw-telegram-async-return health

# 查看最近任务
openclaw-telegram-async-return recent --chat <chat-id>

# 查询任务状态
openclaw-telegram-async-return status --task <task-id>

# 重发结果
openclaw-telegram-async-return resend --task <task-id>

# 诊断问题
openclaw-telegram-async-return diagnose --task <task-id>

# 修复投递
openclaw-telegram-async-return repair --chat <chat-id>
```

## 用户跟进场景

### 用户说「刚才那个呢」

1. 查最近任务状态
2. `running` → 告知还在处理中，不重复执行
3. `waiting_delivery` → 正在投递，或触发 resend
4. `delivery_failed` → resend
5. `delivered` → 告知已发送，可重发
6. `failed` → 告知执行失败，可重跑

### 用户重复发送相同请求

自动去重：在配置的时间窗口内，相同 chat + 相同 prompt hash 或相同 source message 会复用已有任务，不重复执行。

## Deployment Notes

### 环境要求

本插件面向支持以下能力的 OpenClaw 环境：

| 接口 | 用途 | 是否必须 |
|------|------|---------|
| `api.on(event, handler)` | 注册事件钩子 | 必须 |
| `api.registerService(service)` | 注册插件服务 | 必须 |
| `api.registerCommand(command)` | 注册命令处理器 | 必须 |
| `api.sendMessage(msg)` | 发送异步结果 | 可选（缺失时第一层功能仍可用） |

### 发送层适配

若当前环境不提供 `api.sendMessage()`：

1. 插件基础功能（追踪、诊断、repair）正常工作
2. 自动回传不可用，任务会停在 `waiting_delivery` 或 `delivery_failed`
3. 需自行实现发送适配层并注入到 `api.sendMessage`
4. 建议 `autoResendOnDeliveryFailure` 设为 `false` 直到发送层就绪

### gateway_stop 兼容

部分 OpenClaw 环境使用 `gateway_stop` 而非 `gateway:shutdown` 或 `gateway_shutdown`。插件已注册全部三种格式，无需额外配置。

### 生产部署检查清单

1. 确认插件注册日志出现
2. 执行 `/async-return health` 确认 `sendMessage` 状态
3. 发送测试消息验证 `queued → running` 转换
4. 若有 `agent:end`，验证 `running → waiting_delivery` 转换
5. 若有 `api.sendMessage()`，验证 `waiting_delivery → delivering → delivered` 完整链路
6. 若任何环节不通，记录停滞状态，对照故障判断表排查

**正式生产部署前，必须完成完整状态机验证。**

## Known Issues

1. **部分 OpenClaw 版本不提供 `api.sendMessage()`**
   - 插件不会崩溃，但自动回传不可用
   - 需自行适配发送层

2. **部分环境使用 `gateway_stop` 而非 `gateway_shutdown`**
   - 插件已注册 `gateway:shutdown`、`gateway_shutdown`、`gateway_stop` 三种格式
   - 若环境使用其他命名，需额外注册

3. **`message:sent` 事件语义在不同运行时可能不同**
   - 部分环境的 `message:sent` 表示消息已提交到发送队列，而非 Telegram 实际已收到
   - 可能导致任务标记为 `delivered` 但用户未收到消息

4. **`agent:end` 事件字段可能与插件预期不匹配**
   - 插件期望 context 包含 `taskId`、`chatId`、`sessionId` 中至少一个
   - 若全部缺失，插件会记录 debug 日志但无法关联到已追踪任务

5. **按文本长度自动识别长任务可能误判**
   - 默认已禁用（`asyncTextLengthThreshold: 0`）
   - 启用后，普通长消息也会被识别为长任务并触发确认回复
   - 建议优先使用 `asyncReturn: true` 或 `tags` 显式标记

6. **双格式 hook 同时触发时的重复执行**
   - 插件依赖幂等和去重避免重复处理
   - 极端情况下（如数据库锁竞争）可能出现微小的时间窗口重复

## 技术栈

- **TypeScript** (ESM)
- **better-sqlite3** (WAL 模式)
- **vitest**

## 开发

```bash
npm install
npm run build
npm test
```

## 项目结构

```
src/
├── index.ts          # 插件入口，注册 service / command / hooks
├── types.ts          # 类型定义
├── config.ts         # 配置解析与默认值
├── service.ts        # SQLite 持久化任务 CRUD
├── commands.ts       # CLI / skill 命令处理
├── hooks.ts          # OpenClaw 事件钩子
├── scheduler.ts      # delivery 重试调度器
└── cli.ts            # 独立 CLI 入口

skills/
└── telegram-async-return/
    └── SKILL.md      # Agent skill 定义

docs/
└── openclaw-integration.md  # OpenClaw 集成指南

test/
├── service.test.ts
├── commands.test.ts
├── hooks.test.ts
└── scheduler.test.ts
```

## License

UNLICENSED
