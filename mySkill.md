# mySkill

## 当前问题
在 Telegram 中，用户发送较长任务后，openClaw 后台还在继续执行，但 Telegram webhook 的等待窗口已经结束，Telegram 侧先收到了 HTTP 返回，最终结果没有可靠发回聊天界面，导致用户误以为任务没完成并重复追问。

## 问题本质
不是任务执行失败，而是：

- 同步响应先结束
- 后台任务继续运行
- 缺少可靠的异步结果回传、重试和恢复机制

## 推荐解决方案
不要只做纯 skill，推荐做成一个可安装即用的方案包：

- `plugin`
- `bundled skill`
- `sidecar runtime`

### plugin
负责接入 openClaw 的 Telegram 与任务生命周期：
- 识别长任务
- 建立 `taskId`
- 监听任务完成
- 触发补发

### skill
负责用户和操作者入口：
- 查询状态
- 重发结果
- 诊断问题
- 执行 repair

### sidecar runtime
负责可靠运行：
- 状态持久化
- delivery 重试
- 幂等控制
- 重启恢复

## 核心能力
- 长任务转后台继续执行
- 先回复“已接收，后台处理中”
- 任务完成后自动回传最终结果
- 识别用户重复追问，优先命中已有任务
- delivery 失败后支持 resend / repair

## 当前已整理文件
- `mySkill/skills/telegram-async-return/SKILL.md`
- `mySkill/openclaw.plugin.json`
- `mySkill/src/index.ts`
- `mySkill/design.md`
- `mySkill/mySkill.md`
- `mySkill/src/types.ts`
- `mySkill/src/config.ts`
- `mySkill/src/service.ts` (SQLite 版，better-sqlite3，WAL 模式)
- `mySkill/src/commands.ts`
- `mySkill/src/hooks.ts` (含 scheduler 生命周期接入)
- `mySkill/src/scheduler.ts` (delivery 重试调度器)
- `mySkill/src/cli.ts`
- `mySkill/src/runtime-shims.d.ts`
- `mySkill/src/openclaw-plugin-sdk.d.ts`
- `mySkill/package.json`
- `mySkill/tsconfig.json`
- `mySkill/test/service.test.ts` (19 tests)
- `mySkill/test/commands.test.ts` (9 tests)
- `mySkill/test/scheduler.test.ts` (6 tests)

## 当前状态
- 构建通过 (`tsc -p tsconfig.json` exit 0)
- CLI 冒烟通过 (`node dist/cli.js health` 正常输出)
- 持久化: SQLite (better-sqlite3, WAL, 5 个索引)
- delivery 重试调度器已实现 (指数退避、jitter、maxAttempts、幂等)
- 单元测试 34/34 全过 (`vitest run`)

## 下一步建议
- 接入真实 openClaw 事件模型，收紧 hooks 字段读取
- 集成测试 (端到端 hook → service → scheduler → deliver)
- 发布为 npm 包
