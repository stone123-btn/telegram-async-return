# @openclaw/telegram-async-return

> OpenClaw 插件包 —— 解决 Telegram 长任务超时后结果丢失问题。

## 问题

用户在 Telegram 发起长任务时，webhook 等待窗口先于任务完成而关闭，导致最终结果无法回传，用户误以为任务失败并重复追问。

## 方案

**plugin + bundled skill + sidecar runtime** 三层架构：

| 层 | 职责 |
|---|---|
| **Plugin** | 接入 openClaw 任务生命周期：识别长任务、建立追踪、监听完成、触发补发 |
| **Skill** | 用户和运维入口：状态查询、结果重发、问题诊断、数据修复 |
| **Runtime** | SQLite 持久化 + delivery 重试调度（指数退避、jitter、幂等、重启恢复） |

## 核心能力

- 🔄 长任务自动转后台，先回复「已接收，后台处理中」
- 📬 任务完成后自动回传最终结果到 Telegram
- 🔍 识别用户重复追问，优先命中已有任务而非重复执行
- 🔁 delivery 失败自动重试（指数退避 + jitter + maxAttempts）
- 🛠 进程重启后自动恢复未完成投递

## 任务状态机

```
queued → running → waiting_delivery → delivering → delivered
                         ↓                ↓
                       failed       delivery_failed
```

## 安装

```bash
npm install @openclaw/telegram-async-return
```

## 兼容性

- **OpenClaw 版本**：需要支持 `api.on()`、`api.registerService()`、`api.registerCommand()` 的 OpenClaw 版本
- **核心依赖接口**：
  - `api.on(event, handler)` — 注册事件钩子
  - `api.registerService(service)` — 注册插件服务
  - `api.registerCommand(command)` — 注册命令处理器
  - `api.sendMessage(msg)` — 发送异步结果消息（可选，缺失时投递降级为失败但不崩溃）

## 事件钩子

插件同时注册冒号格式和下划线格式的 hook 名称，确保不同版本 OpenClaw 兼容：

| 用途 | 冒号格式 | 下划线格式 |
|------|----------|------------|
| 网关启动 | `gateway:startup` | `gateway_start` |
| 网关关闭 | `gateway:shutdown` | `gateway_shutdown` |
| 收到消息 | `message:received` | `message_received` |
| 消息已发送 | `message:sent` | `message_sent` |
| Agent 结束 | `agent:end` | `agent_end` |

> **注意**：如果 OpenClaw 同时触发两种格式事件，handler 会执行两次。插件内置去重 + 状态检查保证幂等。

## 消息发送接口

插件通过 `api.sendMessage()` 发送异步结果到用户。

- **接口可用时**：正常投递结果
- **接口不可用时**：记录 warn 日志，投递返回 false，任务进入 `delivery_failed` 状态，等待后续重试或手动 repair
- 不会因接口缺失而抛出异常或导致插件崩溃

## 验证安装

1. `/async-return health` — 检查 `enabled`、`sendMessage`、`hooks` 状态
2. 启动日志 — 应看到 `[telegram-async-return] registering plugin`
3. 发送 `asyncReturn: true` 的测试消息，验证任务追踪是否正常

## 钩子不可用时的处理

- `message:sent` 不可用 → 任务停在 `delivering` 状态，重启后恢复或手动 `repair`
- `agent:end` 不可用 → 任务停在 `running` 状态，需外部调用 `completeTask` 或 `repair`

## 快速开始

### 1. 注册插件

在 openClaw 配置中引入插件：

```jsonc
// openclaw.config.json
{
  "plugins": ["@openclaw/telegram-async-return"]
}
```

### 2. 配置（可选）

所有配置项均有合理默认值，开箱即用：

```jsonc
{
  "enabled": true,
  "storePath": ".openclaw/telegram-async-return/store.db",
  "ackOnAsyncStart": true,
  "ackTemplate": "已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。",
  "asyncTextLengthThreshold": 0, // 默认 0（禁用文本长度检测），设为正数启用（如 120）
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

### 3. 使用 Skill 命令

在 Telegram 中通过 openClaw 调用：

```
/async-return status --chat <chat-id> --latest
/async-return resend --task <task-id>
/async-return diagnose --task <task-id>
/async-return repair --chat <chat-id>
```

## CLI

独立 CLI 可直接在服务器上使用：

```bash
# 检查运行状态
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

## 技术栈

- **TypeScript** (ESM)
- **better-sqlite3** (WAL 模式)
- **vitest** (34 tests)

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行测试
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
├── hooks.ts          # openClaw 事件钩子
├── scheduler.ts      # delivery 重试调度器
└── cli.ts            # 独立 CLI 入口

skills/
└── telegram-async-return/
    └── SKILL.md      # Agent skill 定义

test/
├── service.test.ts   # 19 tests
├── commands.test.ts  # 9 tests
└── scheduler.test.ts # 6 tests
```

## License

UNLICENSED
