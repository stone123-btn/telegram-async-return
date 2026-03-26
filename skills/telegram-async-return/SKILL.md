---
name: telegram-async-return
description: Use when OpenClaw handles Telegram tasks that may outlive the webhook wait window, or when a user reports a missing final reply, asks for resend or status, or repeats a recent long-running request after timeout or restart.
metadata:
  {
    "openclaw":
      {
        "emoji": "📬",
        "requires": { "bins": ["openclaw-telegram-async-return"], "config": ["channels.telegram.enabled"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@openclaw/telegram-async-return",
              "bins": ["openclaw-telegram-async-return"],
              "label": "Install Telegram async return package",
            },
          ],
      },
  }
---

# Telegram Async Return

Use this skill with the installed `telegram-async-return` package.

This skill handles the agent-side workflow for Telegram long-running tasks that can outlive the webhook response window. Reliable delivery, retries, persistence, and recovery come from the package runtime; this skill tells the agent when to switch into async-return behavior and how to handle follow-up messages safely.

## Trigger Signs

Use this skill when any of these are true:

- The Telegram request is likely to run longer than the webhook wait window.
- A task keeps running after Telegram has already accepted the webhook response.
- The user says things like:
  - “刚才那个呢”
  - “结果没收到”
  - “继续上一个”
  - “再发一次结果”
  - “刚才那个任务完成了吗”
- A user sends a near-duplicate follow-up shortly after a long task started.
- OpenClaw or the host restarted, and a recent Telegram result may not have been delivered.

## Core Rules

- Never treat a webhook timeout as task failure.
- Never blindly rerun a recent long Telegram task before checking async task status.
- Prefer `status`, `recent`, `resend`, or `repair` over duplicate execution.
- When switching to background mode, send a short acknowledgement immediately.
- Keep a stable `taskId` in operator-visible status, resend, and repair flows.
- Distinguish execution failure from delivery failure.
- Do not mark a task done until final Telegram delivery is confirmed.
- If the runtime is unavailable, say so explicitly and fall back to status guidance instead of pretending delivery is reliable.

## Workflow

### 1. Detect likely long-running work

Switch into async-return mode when the request is likely to outlive the Telegram webhook wait window or when a prior long-running Telegram task is already in progress for the same chat or thread.

### 2. Check runtime health first

Before using async-return operations, verify the runtime is available:

```bash
openclaw-telegram-async-return health
```

If health fails, do not promise automatic writeback. Tell the user that background delivery tracking is currently unavailable.

### 3. Reuse tracked work before creating new work

If the user is clearly referring to a recent in-flight or recently completed task, check existing records before starting anything new.

Preferred checks:

```bash
openclaw-telegram-async-return recent --chat <chat-id>
openclaw-telegram-async-return status --chat <chat-id> --latest
```

If a matching task is still `running`, `waiting_delivery`, or `delivering`, continue using that task rather than creating a new one.

### 4. Send immediate Telegram acknowledgement

When async-return mode is used, send a short acknowledgement right away.

Preferred wording:

- `已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。`
- `这个任务会继续在后台运行。我先记住这次请求，完成后会自动回传结果。`

Keep this short. Do not include speculative time estimates.

### 5. Use status-driven follow-up behavior

When the user follows up, always branch on task state instead of guessing.

Task states:

- `queued`
- `running`
- `waiting_delivery`
- `delivering`
- `sent_confirmed`
- `failed`
- `delivery_failed`
- `cancelled`

### 6. Prefer resend and repair over rerun

If execution already finished and only delivery failed, resend the result instead of rerunning the original task.

## Operator Commands

These commands assume the package ships a CLI named `openclaw-telegram-async-return`.

### Health

```bash
openclaw-telegram-async-return health
```

Use to confirm the async runtime is available before relying on automatic writeback.

### Recent tasks

```bash
openclaw-telegram-async-return recent --chat <chat-id>
```

Use when the user asks about a recent long-running request and you need to find candidate tasks.

### Latest task status for a chat

```bash
openclaw-telegram-async-return status --chat <chat-id> --latest
```

Use when the user says “刚才那个呢” or similar and no explicit `taskId` is available.

### Specific task status

```bash
openclaw-telegram-async-return status --task <task-id>
```

Use when a `taskId` is already known.

### Resend final result

```bash
openclaw-telegram-async-return resend --task <task-id>
```

Use when the task already completed but the final Telegram reply was not delivered or the user asks to send it again.

### Diagnose delivery or tracking issues

```bash
openclaw-telegram-async-return diagnose --task <task-id>
```

Use when state looks inconsistent, delivery keeps failing, or recovery is needed.

### Attempt repair for a chat

```bash
openclaw-telegram-async-return repair --chat <chat-id>
```

Use when tracking data or delivery state is damaged and you need the runtime to reconcile pending work.

## Decision Guide

### Case A: User asks where the result went

1. Check latest task status for the chat.
2. If status is `running`:
   - Tell the user the task is still running.
   - Do not rerun.
3. If status is `waiting_delivery` or `delivering`:
   - Tell the user the task already finished and is being delivered.
   - If needed, use `resend`.
4. If status is `delivery_failed`:
   - Use `resend`.
   - Explain that execution finished but Telegram delivery failed.
5. If status is `sent_confirmed`:
   - Summarize that the host confirmed sending the result.
   - If the user still wants it again, use `resend`.
6. If status is `failed`:
   - Explain that execution failed.
   - Only then consider rerun or a revised request.

### Case B: User sends a near-duplicate follow-up

1. Check recent tasks for the same chat or thread.
2. If a matching task is still active:
   - Reuse that task.
   - Return status instead of starting a new run.
3. If a matching task already completed:
   - Return the result or resend it.
4. Only start a new task if the prior task is clearly unrelated or the user explicitly asks to rerun.

### Case C: Runtime unavailable

1. Say automatic async writeback is currently unavailable.
2. Do not promise reliable background delivery.
3. If possible, give manual status guidance or ask the operator to inspect runtime health.
4. Prefer honesty over optimistic but false assurances.

## Telegram Reply Templates

### Background acknowledgement

- `已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。`

### Running status

- `上一个任务还在处理中，我先不重复启动。完成后会自动回传结果。`

### Waiting for delivery

- `上一个任务已经完成，正在尝试把结果发回这里。`

### Delivery failed, retrying

- `上一个任务已经完成，但结果回传失败。我现在重新尝试发送。`

### Already sent-confirmed

- `上一个任务的结果已经发出。如果你需要，我可以重新发送一次。`

### Execution failed

- `上一个任务执行失败了，不是 Telegram 超时导致的投递问题。需要的话我可以重新执行或先解释失败原因。`

## Guardrails

- Do not claim a task failed only because Telegram timed out.
- Do not start multiple active long-running tasks for the same chat or thread unless the user explicitly asks for a rerun.
- Do not confuse missing delivery with failed execution.
- Do not promise that the final result will appear in the same webhook response.
- Do not send duplicate final replies when status already shows `sent_confirmed`.
- Do not hide runtime or delivery problems from the user.
- Do not emit partial or streaming external replies if channel policy forbids them.
- Do not clear or overwrite task history unless the operator explicitly asks for repair or cleanup.

## Recovery Flow

When delivery or tracking is broken, use this order:

1. `health`
2. `recent`
3. `status`
4. `resend`
5. `diagnose`
6. `repair`

If no task record exists but the user is clearly referring to a recent long-running Telegram request:

- say tracking data is missing or unavailable
- do not pretend the prior task status is known
- ask whether to inspect logs, attempt recovery, or rerun the request

## Package Assumptions

This draft assumes the package provides:

- an OpenClaw plugin that hooks Telegram request handling and task completion
- a sidecar runtime for persistence, retries, and recovery
- a CLI named `openclaw-telegram-async-return`

If the final package uses different binary names, config keys, or command shapes, update this skill to match the shipped runtime exactly.
