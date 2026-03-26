import { resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createDeliveryScheduler, type DeliveryScheduler } from "./scheduler.js";
import type {
  ContractHealth,
  ContractObservation,
  HookContext,
  GatewayStartupEvent,
  GatewayShutdownEvent,
  MessageReceivedEvent,
  MessageSentEvent,
  AgentEndEvent,
  AsyncTaskState,
  OpenClawEvent,
  TelegramAsyncReturnPluginConfig,
} from "./types.js";

const SCHEDULER_KEY = Symbol.for("openclaw.telegram-async-return.scheduler");

// ---------------------------------------------------------------------------
// Hook activity tracking
// ---------------------------------------------------------------------------

const HOOK_ACTIVITY_KEY = Symbol.for("openclaw.telegram-async-return.hookActivity");
const CONTRACT_HEALTH_KEY = Symbol.for("openclaw.telegram-async-return.contractHealth");

interface HookActivity {
  gatewayStart: boolean;
  gatewayStop: boolean;
  messageReceived: boolean;
  messageSent: boolean;
  agentEnd: boolean;
}

function recordHookFired(runtime: unknown, hook: keyof HookActivity) {
  if (typeof runtime !== "object" || runtime === null) return;
  const r = runtime as Record<symbol, unknown>;
  let activity = r[HOOK_ACTIVITY_KEY] as HookActivity | undefined;
  if (!activity) {
    activity = {
      gatewayStart: false,
      gatewayStop: false,
      messageReceived: false,
      messageSent: false,
      agentEnd: false,
    };
    r[HOOK_ACTIVITY_KEY] = activity;
  }
  activity[hook] = true;
}

export function getHookActivity(runtime: unknown): HookActivity | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;
  return (runtime as Record<symbol, unknown>)[HOOK_ACTIVITY_KEY] as HookActivity | undefined;
}

function getOrCreateContractHealth(runtime: unknown): ContractHealth | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;

  const record = runtime as Record<symbol, unknown>;
  let health = record[CONTRACT_HEALTH_KEY] as ContractHealth | undefined;
  if (!health) {
    health = {
      agentEndIdentifiers: "unseen",
      messageSentTaskId: "unseen",
      deliverySignal: "host_send_ack",
    };
    record[CONTRACT_HEALTH_KEY] = health;
  }

  return health;
}

function recordContractObservation(
  runtime: unknown,
  key: Exclude<keyof ContractHealth, "deliverySignal">,
  value: ContractObservation,
) {
  const health = getOrCreateContractHealth(runtime);
  if (!health) return;

  if (health[key] === "ok") {
    return;
  }

  health[key] = value;
}

export function getContractHealth(runtime: unknown): ContractHealth | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;
  return getOrCreateContractHealth(runtime);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGatewayStart(context: HookContext<GatewayStartupEvent>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "gatewayStart");

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

  recordHookFired(context.api.runtime, "gatewayStop");

  const scheduler = loadScheduler(context.api.runtime);
  if (scheduler) {
    scheduler.stop();
  }

  log(context, "info", "gateway:shutdown async-return idle");
}

export async function handleMessageReceived(context: HookContext<MessageReceivedEvent>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "messageReceived");

  const eventContext = context.event?.context;
  if (!eventContext) {
    log(context, "debug", "message:received with no context — skipping");
    return;
  }

  if (!isTelegramEvent(context.event) || !shouldTrackAsyncTask(context.event, config)) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const { chatId, threadId, sessionId, messageId: sourceMessageId, text: prompt } = eventContext;

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
    await eventContext.reply?.(config.ackTemplate);
    await service.acknowledgeTask(tracked.task.taskId, config.ackTemplate);
  }

  log(context, "info", `message:received task=${tracked.task.taskId} reused=${String(tracked.reused)}`);
  return tracked;
}

export async function handleMessageSent(context: HookContext<MessageSentEvent>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "messageSent");

  const eventContext = context.event?.context;
  if (!eventContext) {
    log(context, "debug", "message:sent with no context — skipping");
    return;
  }

  if (!isTelegramEvent(context.event)) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const { taskId, kind, error, source } = eventContext;

  if (!taskId) {
    recordContractObservation(context.api.runtime, "messageSentTaskId", "missing");
    log(context, "debug", "message:sent without taskId — skipping");
    return;
  }

  recordContractObservation(context.api.runtime, "messageSentTaskId", "ok");

  if (kind === "delivery_failed") {
    await service.markDeliveryFailed(taskId, error ?? "Telegram delivery failed");
    return;
  }

  // Skip events not originating from this plugin
  if (source !== undefined && source !== "async-return" && source !== "async-return-scheduler") {
    log(context, "debug", `message:sent task=${taskId} source="${source}" — not from async-return, skipping`);
    return;
  }

  const DELIVERABLE_STATES: AsyncTaskState[] = ["waiting_delivery", "delivering", "delivery_failed"];
  const task = await service.getStatus({ taskId });
  if (!task || !DELIVERABLE_STATES.includes(task.state)) {
    log(context, "debug", `message:sent task=${taskId} state=${task?.state} not deliverable, skipping`);
    return;
  }

  await service.markSentConfirmed(taskId);
  log(context, "info", `message:sent host-confirmed task=${taskId}`);
}

export async function handleAgentEnd(context: HookContext<AgentEndEvent>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "agentEnd");

  const eventContext = context.event?.context;
  if (!eventContext) {
    log(context, "debug", "agent:end with no context — skipping");
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const { taskId, chatId, sessionId, status, error, resultSummary, resultPayload } = eventContext;

  if (!taskId && !chatId && !sessionId) {
    recordContractObservation(context.api.runtime, "agentEndIdentifiers", "missing");
    log(context, "debug",
      `agent:end without taskId/chatId/sessionId — event keys: ${JSON.stringify(Object.keys(eventContext))}`);
    return;
  }

  recordContractObservation(context.api.runtime, "agentEndIdentifiers", "ok");

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
  return event?.context?.channel === "telegram";
}

function shouldTrackAsyncTask(event: MessageReceivedEvent, config: TelegramAsyncReturnPluginConfig): boolean {
  if (event?.context?.asyncReturn) {
    return true;
  }

  const tags = event?.context?.tags;
  if (Array.isArray(tags) && tags.some((tag) => ["long-task", "async", "background"].includes(tag))) {
    return true;
  }

  const threshold = config.asyncTextLengthThreshold;
  if (threshold > 0 && (event?.context?.text ?? "").length >= threshold) {
    return true;
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
  let warnedMissing = false;
  return async (task: { taskId: string; chatId?: string; resultSummary?: string; resultPayload?: unknown }) => {
    const sendMessage = context.api.sendMessage;
    if (typeof sendMessage !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        log(context, "warn", "api.sendMessage is not available — deliveries will fail until it is registered");
      }
      return false;
    }
    await sendMessage({
      chatId: task.chatId,
      text: task.resultSummary ?? JSON.stringify(task.resultPayload ?? "Task completed."),
      metadata: { taskId: task.taskId, source: "async-return-scheduler" },
    });
    return true;
  };
}
