# OpenClaw Telegram 异步回传方案包设计文档

## 背景
当前 openClaw 在 Telegram 场景下存在一个典型长任务交付问题：用户发起长任务后，Telegram webhook 等待窗口先结束，openClaw 后台任务继续跑，但最终结果没有可靠回传到 Telegram，导致用户重复追问或重复提交。

这个问题的本质不是任务执行失败，而是前台同步响应早于后台任务生命周期结束，且缺少可靠的异步结果回传层。

## 目标
设计一个可安装即用的 openClaw 方案包，用于解决 Telegram 中长任务超时后结果丢失的问题，要求：

1. 可安装到其他 openClaw 实例。
2. 不依赖当前本地私有配置。
3. 自带运行环境。
4. 支持后台继续执行、自动补发最终结果。
5. 支持重复追问命中已有任务。
6. 提供明确状态与恢复能力。

## 结论
推荐采用：`plugin + bundled skill + sidecar runtime`

原因：
- 纯 skill 适合流程指导，不适合承担后台常驻、状态持久化、结果补发、失败重试、重启恢复。
- openClaw 已有 Telegram webhook、delivery、writeback、session queue 基础，可在其上增加异步交付层。

## 推荐架构
### 1. plugin
负责接入 openClaw 与 Telegram 任务链路：
- 识别长任务
- 建立 taskId / session 关联
- 监听任务完成事件
- 触发结果补发

### 2. skill
负责用户入口与运维入口：
- `/async-return status`
- `/async-return recent`
- `/async-return resend`
- `/async-return diagnose`
- `/async-return repair`

### 3. sidecar runtime
负责可靠运行：
- 状态持久化
- 重试与补发
- 幂等控制
- 重启恢复

## 核心状态机
- `queued`
- `running`
- `waiting_delivery`
- `delivering`
- `sent_confirmed`
- `failed`
- `delivery_failed`
- `cancelled`

## 核心流程
### 长任务首次进入
1. Telegram 请求进入。
2. 判断可能超时。
3. 创建 `taskId` 与任务记录。
4. 后台继续运行。
5. 先向 Telegram 回复“已接收，后台处理中”。

### 任务完成后补发
1. 监听到任务完成。
2. 写入结果。
3. 放入 delivery 队列。
4. 向 Telegram 补发最终结果。
5. 成功则标记 `sent_confirmed`，失败则进入重试。

### 用户重复追问
1. 查找最近相关任务。
2. 若还在运行，返回状态。
3. 若已完成未送达，尝试 resend。
4. 若已送达，返回摘要或重新推送。

### 进程重启恢复
1. 启动时扫描未完成或未送达任务。
2. 恢复 delivery 或标记失败。
3. 提供查询与 repair 能力。

## 与现有 openClaw 的映射
关键依据：
- `app/src/telegram/webhook.ts`
- `app/src/telegram/lane-delivery.ts`
- `app/src/telegram/target-writeback.ts`
- `app/src/acp/control-plane/session-actor-queue.ts`
- `app/docs/channels/telegram.md`
- `app/docs/tools/skills.md`

## MVP 建议
第一阶段只做 Telegram：
1. 长任务识别
2. taskId 持久化
3. 后台完成自动补发
4. delivery 重试
5. 状态查询
6. 重复追问命中已有任务

## 当前骨架文件
- `mySkill/skills/telegram-async-return/SKILL.md`
- `mySkill/openclaw.plugin.json`
- `mySkill/src/index.ts`

后续建议继续补：
- `mySkill/src/config.ts`
- `mySkill/src/service.ts`
- `mySkill/src/commands.ts`
- `mySkill/src/hooks.ts`
- `mySkill/src/types.ts`
