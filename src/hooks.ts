import { resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createDeliveryScheduler, type DeliveryScheduler } from "./scheduler.js";
import type {
  HookContext,
  GatewayStartupEvent,
  GatewayShutdownEvent,
  MessageReceivedEvent,
  MessageSentEvent,
  AgentEndEvent,
  OpenClawEvent,
} from "./types.js";

const SCHEDULER_KEY = Symbol.for("openclaw.telegram-async-return.scheduler");

export async function handleGatewayStart(context: HookContext<GatewayStartupEvent>) {
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
    log(context, "info", `gateway:startup recovered=${recovery.repairedTaskIds.length}`);
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
    log(context, "info", "delivery scheduler started on gateway:startup");
  }
}

export async function handleGatewayStop(context: HookContext<GatewayShutdownEvent>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  const scheduler = loadScheduler(context.api.runtime);
  if (scheduler) {
    scheduler.stop();
  }

  log(context, "info", "gateway:shutdown async-return idle");
}

export async function handleMessageReceived(context: HookContext<MessageReceivedEvent>) {
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

  const { chatId, threadId, sessionId, messageId: sourceMessageId, text: prompt } = context.event.context;

  const tracked = await service.trackTask({
    chatId,
    threadId,
    sessionId,
    sourceMessageId,
    prompt,
    metadata: {
      source: "message:received",
      transport: "telegram",
    },
  });

  if (!tracked.reused) {
    await service.startTask(tracked.task.taskId);
  }

  if (config.ackOnAsyncStart && !tracked.task.ackSentAt) {
    await context.event.context.reply?.(config.ackTemplate);
    await service.acknowledgeTask(tracked.task.taskId, config.ackTemplate);
  }

  log(context, "info", `message:received task=${tracked.task.taskId} reused=${String(tracked.reused)}`);
  return tracked;
}

export async function handleMessageSent(context: HookContext<MessageSentEvent>) {
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

  const { taskId, kind, error } = context.event.context;

  if (!taskId) {
    return;
  }

  if (kind === "delivery_failed") {
    await service.markDeliveryFailed(taskId, error ?? "Telegram delivery failed");
    return;
  }

  await service.markDelivered(taskId);
  log(context, "info", `message:sent delivered task=${taskId}`);
}

export async function handleAgentEnd(context: HookContext<AgentEndEvent>) {
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

  const { taskId, chatId, sessionId, status, error, resultSummary, resultPayload } = context.event.context;

  const completed = await service.completeTask({
    taskId,
    chatId,
    sessionId,
    success: !error && status !== "failed" && status !== "error",
    resultSummary,
    resultPayload,
    error,
    metadata: {
      source: "agent:end",
      status,
    },
  });

  if (!completed) {
    return;
  }

  if (completed.state === "waiting_delivery" && config.autoResendOnDeliveryFailure) {
    await service.resendTask(completed.taskId);
  }

  log(context, "info", `agent:end task=${completed.taskId} state=${completed.state}`);
  return completed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTelegramEvent(event: MessageReceivedEvent | MessageSentEvent): boolean {
  return event.context.channel === "telegram";
}

function shouldTrackAsyncTask(event: MessageReceivedEvent): boolean {
  if (event.context.asyncReturn) {
    return true;
  }

  const text = event.context.text ?? "";
  if (text.length >= 120) {
    return true;
  }

  const tags = event.context.tags;
  if (Array.isArray(tags)) {
    return tags.some((tag) => ["long-task", "async", "background"].includes(tag));
  }

  return false;
}

function log<E extends OpenClawEvent>(context: HookContext<E>, level: "info" | "warn" | "error" | "debug", message: string) {
  const method = context.api.logger?.[level];
  if (typeof method === "function") {
    method(`[telegram-async-return] ${message}`);
  }
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

function buildDeliverFn<E extends OpenClawEvent>(context: HookContext<E>) {
  return async (task: { taskId: string; chatId?: string; resultSummary?: string; resultPayload?: unknown }) => {
    const runtime = context.api.runtime;
    const sendMessage = runtime?.["sendTelegramMessage"] as
      | ((msg: Record<string, unknown>) => Promise<void>)
      | undefined;
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
