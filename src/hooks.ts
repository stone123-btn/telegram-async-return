import { resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createDeliveryScheduler, type DeliveryScheduler } from "./scheduler.js";
import type { HookContext } from "./types.js";

const SCHEDULER_KEY = Symbol.for("openclaw.telegram-async-return.scheduler");

export async function handleGatewayStart(context: HookContext) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  if (config.recovery.enabled && config.recovery.scanOnStartup) {
    const recovery = await service.recoverPendingTasks();
    log(context, "info", `gateway_start recovered=${recovery.repairedTaskIds.length}`);
  }

  if (config.autoResendOnDeliveryFailure) {
    const scheduler = createDeliveryScheduler({
      service,
      config,
      deliver: buildDeliverFn(context),
      logger: context.api.logger,
    });
    scheduler.start();
    storeScheduler(context.api.runtime, scheduler);
    log(context, "info", "delivery scheduler started on gateway_start");
  }
}

export async function handleGatewayStop(context: HookContext) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  const scheduler = loadScheduler(context.api.runtime);
  if (scheduler) {
    scheduler.stop();
  }

  log(context, "info", "gateway_stop async-return idle");
}

export async function handleMessageReceived(context: HookContext) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled || !isTelegramEvent(context.event) || !shouldTrackAsyncTask(context.event)) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const chatId = readString(context.event, [
    ["chatId"],
    ["chat", "id"],
    ["message", "chat", "id"],
    ["payload", "chatId"],
  ]);
  const threadId = readString(context.event, [["threadId"], ["messageThreadId"], ["message", "threadId"]]);
  const sessionId = readString(context.event, [["sessionId"], ["session", "id"], ["payload", "sessionId"]]);
  const sourceMessageId = readString(context.event, [
    ["messageId"],
    ["message", "id"],
    ["payload", "messageId"],
  ]);
  const prompt = readString(context.event, [
    ["text"],
    ["message", "text"],
    ["prompt"],
    ["payload", "prompt"],
  ]);

  const tracked = await service.trackTask({
    chatId,
    threadId,
    sessionId,
    sourceMessageId,
    prompt,
    metadata: {
      source: "message_received",
      transport: "telegram",
    },
  });

  if (!tracked.reused) {
    await service.startTask(tracked.task.taskId);
  }

  if (config.ackOnAsyncStart && !tracked.task.ackSentAt) {
    await maybeReply(context.event, config.ackTemplate);
    await service.acknowledgeTask(tracked.task.taskId, config.ackTemplate);
  }

  log(context, "info", `message_received task=${tracked.task.taskId} reused=${String(tracked.reused)}`);
  return tracked;
}

export async function handleMessageSent(context: HookContext) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled || !isTelegramEvent(context.event)) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const taskId = readString(context.event, [
    ["taskId"],
    ["payload", "taskId"],
    ["metadata", "taskId"],
    ["metadata", "asyncReturnTaskId"],
  ]);

  if (!taskId) {
    return;
  }

  const messageKind = readString(context.event, [["kind"], ["payload", "kind"], ["message", "kind"]]);
  if (messageKind === "delivery_failed") {
    const error = readString(context.event, [["error"], ["payload", "error"], ["message", "error"]]) ?? "Telegram delivery failed";
    await service.markDeliveryFailed(taskId, error);
    return;
  }

  await service.markDelivered(taskId);
  log(context, "info", `message_sent delivered task=${taskId}`);
}

export async function handleAgentEnd(context: HookContext) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const taskId = readString(context.event, [["taskId"], ["payload", "taskId"], ["metadata", "taskId"]]);
  const chatId = readString(context.event, [["chatId"], ["payload", "chatId"], ["chat", "id"]]);
  const sessionId = readString(context.event, [["sessionId"], ["session", "id"], ["payload", "sessionId"]]);
  const status = readString(context.event, [["status"], ["result", "status"], ["payload", "status"]]);
  const error = readString(context.event, [["error"], ["payload", "error"], ["result", "error"]]);
  const resultSummary = readString(context.event, [
    ["summary"],
    ["result", "summary"],
    ["payload", "summary"],
    ["result", "text"],
  ]);
  const resultPayload = readValue(context.event, [["result"], ["payload", "result"], ["output"]]);

  const completed = await service.completeTask({
    taskId,
    chatId,
    sessionId,
    success: !error && status !== "failed" && status !== "error",
    resultSummary,
    resultPayload,
    error,
    metadata: {
      source: "agent_end",
      status,
    },
  });

  if (!completed) {
    return;
  }

  if (completed.state === "waiting_delivery" && config.autoResendOnDeliveryFailure) {
    await service.resendTask(completed.taskId);
  }

  log(context, "info", `agent_end task=${completed.taskId} state=${completed.state}`);
  return completed;
}

function isTelegramEvent(event: unknown) {
  const channel = readString(event, [["channel"], ["transport"], ["source"], ["payload", "channel"]]);
  if (channel) {
    return channel.toLowerCase() === "telegram";
  }

  const chatId = readString(event, [["chatId"], ["chat", "id"], ["message", "chat", "id"]]);
  return Boolean(chatId);
}

function shouldTrackAsyncTask(event: unknown) {
  const forcedAsync = readBoolean(event, [["asyncReturn"], ["payload", "asyncReturn"], ["metadata", "asyncReturn"]]);
  if (forcedAsync) {
    return true;
  }

  const text = readString(event, [["text"], ["message", "text"], ["prompt"], ["payload", "prompt"]]) ?? "";
  if (text.length >= 120) {
    return true;
  }

  const tags = readValue(event, [["tags"], ["metadata", "tags"], ["payload", "tags"]]);
  if (Array.isArray(tags)) {
    return tags.some((tag) => typeof tag === "string" && ["long-task", "async", "background"].includes(tag));
  }

  return false;
}

async function maybeReply(event: unknown, message: string) {
  const reply = readValue(event, [["reply"], ["respond"]]);
  if (typeof reply === "function") {
    await reply(message);
  }
}

function log(context: HookContext, level: "info" | "warn" | "error" | "debug", message: string) {
  const method = context.api.logger?.[level];
  if (typeof method === "function") {
    method(`[telegram-async-return] ${message}`);
  }
}

function readString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    const candidate = readValue(value, [path]);
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }

    if (typeof candidate === "number") {
      return String(candidate);
    }
  }

  return undefined;
}

function readBoolean(value: unknown, paths: string[][]) {
  for (const path of paths) {
    const candidate = readValue(value, [path]);
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return false;
}

function readValue(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = value;
    let missing = false;

    for (const segment of path) {
      if (typeof current !== "object" || current === null || !(segment in current)) {
        missing = true;
        break;
      }

      current = (current as Record<string, unknown>)[segment];
    }

    if (!missing) {
      return current;
    }
  }

  return undefined;
}

function storeScheduler(runtime: unknown, scheduler: DeliveryScheduler) {
  if (typeof runtime === "object" && runtime !== null) {
    (runtime as Record<symbol, unknown>)[SCHEDULER_KEY] = scheduler;
  }
}

function loadScheduler(runtime: unknown): DeliveryScheduler | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;
  const candidate = (runtime as Record<symbol, unknown>)[SCHEDULER_KEY];
  if (candidate && typeof candidate === "object" && "stop" in candidate) {
    return candidate as DeliveryScheduler;
  }
  return undefined;
}

function buildDeliverFn(context: HookContext) {
  return async (task: { taskId: string; chatId?: string; resultSummary?: string; resultPayload?: unknown }) => {
    const sendMessage = readValue(context.api.runtime, [["sendTelegramMessage"], ["telegram", "send"]]);
    if (typeof sendMessage === "function") {
      await sendMessage({
        chatId: task.chatId,
        text: task.resultSummary ?? JSON.stringify(task.resultPayload ?? "Task completed."),
        metadata: { taskId: task.taskId, source: "async-return-scheduler" },
      });
      return true;
    }
    return false;
  };
}
