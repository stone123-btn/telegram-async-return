import { resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createDeliveryScheduler, type DeliveryScheduler } from "./scheduler.js";
import { resolveSendAdapter } from "./host-send.js";
import {
  initializeWorkingMode,
  recordCapability,
  checkProbeExpiry,
} from "./working-mode.js";
import type {
  AsyncTaskState,
  ClassificationMode,
  ContractHealth,
  HookContext,
  NormalizedAgentEnd,
  NormalizedMessageReceived,
  NormalizedMessageSent,
  TelegramAsyncReturnPluginConfig,
} from "./types.js";

const SCHEDULER_KEY = Symbol.for("openclaw.telegram-async-return.scheduler");
const HOOK_ACTIVITY_KEY = Symbol.for("openclaw.telegram-async-return.hookActivity");
const CONTRACT_HEALTH_KEY = Symbol.for("openclaw.telegram-async-return.contractHealth");

interface HookActivity {
  gatewayStart: boolean;
  gatewayStop: boolean;
  messageReceived: boolean;
  messageSent: boolean;
  agentEnd: boolean;
}

interface TrackDecision {
  shouldTrack: boolean;
  reason: "asyncReturn" | "tag" | "keyword" | "textLength" | "trackAll" | "none";
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

export function getClassificationMode(config: TelegramAsyncReturnPluginConfig): ClassificationMode {
  if (config.trackAllMessages) {
    return "time_based";
  }
  const hasThresholdFallback = config.asyncTextLengthThreshold > 0 || config.classification.acceptPlainLongText;
  const hasKeywords = config.classification.keywordTriggers.length > 0;
  if (!hasThresholdFallback && !hasKeywords) {
    return "explicit_only";
  }
  if (hasThresholdFallback && !hasKeywords) {
    return "threshold_fallback";
  }
  return "hybrid";
}

export function getContractHealth(runtime: unknown): ContractHealth | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;
  return (runtime as Record<symbol, unknown>)[CONTRACT_HEALTH_KEY] as ContractHealth | undefined;
}

function ensureContractHealth(runtime: unknown, config: TelegramAsyncReturnPluginConfig): ContractHealth | undefined {
  if (typeof runtime !== "object" || runtime === null) return undefined;
  const r = runtime as Record<symbol, unknown>;
  let health = r[CONTRACT_HEALTH_KEY] as ContractHealth | undefined;
  if (!health) {
    health = {
      inboundNormalization: "unseen",
      agentCompletionCorrelation: "unseen",
      outboundCorrelation: "unseen",
      classification: getClassificationMode(config),
      deliverySignal: "host_send_ack",
      sendAdapter: undefined,
    };
    r[CONTRACT_HEALTH_KEY] = health;
  } else {
    health.classification = getClassificationMode(config);
  }
  return health;
}

function setContractObservation(
  runtime: unknown,
  key: keyof Pick<ContractHealth, "inboundNormalization" | "agentCompletionCorrelation" | "outboundCorrelation">,
  value: ContractHealth[typeof key],
) {
  if (typeof runtime !== "object" || runtime === null) return;
  const health = (runtime as Record<symbol, unknown>)[CONTRACT_HEALTH_KEY] as ContractHealth | undefined;
  if (health) {
    health[key] = value;
  }
}

export async function handleGatewayStart(context: HookContext<unknown>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "gatewayStart");
  ensureContractHealth(context.api.runtime, config);

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

  const adapter = resolveSendAdapter({
    sendMessage: context.api.sendMessage,
    runtime: context.api.runtime,
    telegramBotToken: config.telegramBotToken,
  });
  if (adapter.kind === "none") {
    log(
      context,
      "warn",
      "no send adapter configured (sendAdapter=none). Tasks will be tracked but results cannot be delivered to Telegram. " +
        "Set TELEGRAM_BOT_TOKEN env var, add telegramBotToken to plugin config, " +
        "or run: async-return setup",
    );
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

export async function handleGatewayStop(context: HookContext<unknown>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "gatewayStop");
  ensureContractHealth(context.api.runtime, config);

  const scheduler = loadScheduler(context.api.runtime);
  if (scheduler) {
    scheduler.stop();
  }

  log(context, "info", "gateway:shutdown async-return idle");
}

export async function handleMessageReceived(context: HookContext<unknown>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "messageReceived");
  ensureContractHealth(context.api.runtime, config);

  try {
    log(context, "info", `message_received raw event: ${JSON.stringify(context.event, null, 2)}`);
  } catch {
    log(context, "info", `message_received raw event: [unserializable]`);
  }

  const normalized = normalizeMessageReceived(context.event, context.api.runtime);
  if (!normalized) {
    setContractObservation(context.api.runtime, "inboundNormalization", "missing");
    logContractMismatch(context, config, "message_received normalization failed");
    return;
  }

  if (!isTelegramNormalizedEvent(normalized.channel)) {
    return;
  }

  // Initialize WorkingMode on first Telegram message
  initializeWorkingMode(context.api.runtime, context.event, config);
  checkProbeExpiry(context.api.runtime, config);

  if (!normalized.chatId && !normalized.sessionId && !normalized.sessionKey) {
    setContractObservation(context.api.runtime, "inboundNormalization", "missing");
    logContractMismatch(context, config, "message_received normalized but missing chatId/sessionId/sessionKey");
    return;
  }

  setContractObservation(
    context.api.runtime,
    "inboundNormalization",
    normalized.chatId && normalized.text ? "ok" : "weak",
  );

  const decision = shouldTrackAsyncTask(normalized, config);
  if (!decision.shouldTrack) {
    if (config.diagnostics.explainClassification) {
      log(
        context,
        "debug",
        `message:received not tracked classification=${getClassificationMode(config)} threshold=${config.asyncTextLengthThreshold} textLength=${normalized.text?.length ?? 0}`,
      );
    }
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  const tracked = await service.trackTask({
    chatId: normalized.chatId,
    threadId: normalized.threadId,
    sessionId: normalized.sessionId,
    sessionKey: normalized.sessionKey,
    sourceMessageId: normalized.messageId,
    prompt: normalized.text,
    metadata: {
      source: "message:received",
      transport: normalized.channel ?? "unknown",
      classificationReason: decision.reason,
    },
  });

  if (!tracked.reused) {
    await service.startTask(tracked.task.taskId);
  }

  // When reason is "trackAll", defer ack — it will be decided at agent_end
  const shouldAck = decision.reason !== "trackAll";
  if (shouldAck && config.ackOnAsyncStart && !tracked.task.ackSentAt && typeof normalized.reply === "function") {
    await normalized.reply(config.ackTemplate);
    await service.acknowledgeTask(tracked.task.taskId, config.ackTemplate);
  }

  log(
    context,
    "info",
    `message:received task=${tracked.task.taskId} reused=${String(tracked.reused)} reason=${decision.reason}`,
  );
  return tracked;
}

export async function handleAgentEnd(context: HookContext<unknown>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "agentEnd");
  ensureContractHealth(context.api.runtime, config);
  recordCapability(context.api.runtime, "agentEnd");
  checkProbeExpiry(context.api.runtime, config);

  const normalized = normalizeAgentEnd(context.event, context.api.runtime);
  if (!normalized) {
    setContractObservation(context.api.runtime, "agentCompletionCorrelation", "missing");
    logContractMismatch(context, config, "agent_end normalization failed");
    return;
  }

  if (!normalized.taskId && !normalized.sessionId && !normalized.chatId && !normalized.sessionKey) {
    setContractObservation(context.api.runtime, "agentCompletionCorrelation", "missing");
    logContractMismatch(context, config, "agent_end missing correlation identifiers");
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  let resolvedTaskId = normalized.taskId;
  if (!resolvedTaskId && normalized.sessionId) {
    resolvedTaskId = (await service.findLatestActiveTaskBySession(normalized.sessionId))?.taskId;
  }
  if (!resolvedTaskId && normalized.sessionKey) {
    resolvedTaskId = (await service.findLatestActiveTaskBySessionKey(normalized.sessionKey))?.taskId;
  }

  const correlation: ContractHealth["agentCompletionCorrelation"] = resolvedTaskId || normalized.sessionId
    ? "ok"
    : (normalized.chatId || normalized.sessionKey ? "weak" : "missing");
  setContractObservation(context.api.runtime, "agentCompletionCorrelation", correlation);

  // Look up the task first to check classification reason and elapsed time
  const existingTask = resolvedTaskId
    ? await service.getStatus({ taskId: resolvedTaskId })
    : await service.getStatus({
        chatId: normalized.chatId,
        sessionId: normalized.sessionId,
        sessionKey: normalized.sessionKey,
        latest: true,
      });

  if (!existingTask) {
    logContractMismatch(context, config, "agent_end could not resolve tracked task from available identifiers");
    return;
  }

  const classificationReason = existingTask.metadata?.classificationReason as string | undefined;
  const isExplicitAsync = classificationReason === "asyncReturn" || classificationReason === "tag";
  const isTrackAll = classificationReason === "trackAll";
  const isSuccess = normalized.success ?? (!normalized.error && normalized.status !== "failed" && normalized.status !== "error");

  // For explicit async tasks, legacy heuristic tasks, or failed tasks, always use the standard completeTask path
  if (isExplicitAsync || !isTrackAll || !isSuccess) {
    const completed = await service.completeTask({
      taskId: existingTask.taskId,
      success: isSuccess,
      resultSummary: normalized.resultSummary,
      resultPayload: normalized.resultPayload,
      error: normalized.error,
      metadata: {
        source: "agent:end",
        status: normalized.status,
      },
    });

    if (!completed) {
      logContractMismatch(context, config, "agent_end could not resolve tracked task from available identifiers");
      return;
    }

    if (completed.state === "waiting_delivery" && config.autoResendOnDeliveryFailure) {
      await service.resendTask(completed.taskId);
    }

    log(context, "info", `agent:end task=${completed.taskId} state=${completed.state}`);
    return completed;
  }

  // Time-based classification: check elapsed time
  const startTime = existingTask.startedAt ?? existingTask.createdAt;
  const elapsedMs = Date.now() - Date.parse(startTime);

  if (elapsedMs < config.webhookTimeoutMs) {
    // Short task — mark as completed_inline, no async delivery needed
    const inlined = await service.markCompletedInline(existingTask.taskId, {
      resultSummary: normalized.resultSummary,
      resultPayload: normalized.resultPayload,
      elapsedMs,
    });

    log(context, "info", `agent:end task=${existingTask.taskId} state=completed_inline elapsed=${elapsedMs}ms`);
    return inlined;
  }

  // Long task — use standard completeTask → waiting_delivery → async delivery
  const completed = await service.completeTask({
    taskId: existingTask.taskId,
    success: true,
    resultSummary: normalized.resultSummary,
    resultPayload: normalized.resultPayload,
    metadata: {
      source: "agent:end",
      status: normalized.status,
      elapsedMs,
    },
  });

  if (!completed) {
    logContractMismatch(context, config, "agent_end could not resolve tracked task from available identifiers");
    return;
  }

  if (completed.state === "waiting_delivery" && config.autoResendOnDeliveryFailure) {
    await service.resendTask(completed.taskId);
  }

  log(context, "info", `agent:end task=${completed.taskId} state=${completed.state} elapsed=${elapsedMs}ms`);
  return completed;
}

export async function handleMessageSent(context: HookContext<unknown>) {
  const config = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  if (!config.enabled) {
    return;
  }

  recordHookFired(context.api.runtime, "messageSent");
  ensureContractHealth(context.api.runtime, config);
  recordCapability(context.api.runtime, "messageSent");
  checkProbeExpiry(context.api.runtime, config);

  const normalized = normalizeMessageSent(context.event, context.api.runtime);
  if (!normalized) {
    setContractObservation(context.api.runtime, "outboundCorrelation", "missing");
    logContractMismatch(context, config, "message_sent normalization failed");
    return;
  }

  if (!isTelegramNormalizedEvent(normalized.channel)) {
    return;
  }

  const service = createTelegramAsyncReturnService({
    pluginConfig: context.pluginConfig,
    logger: context.api.logger,
    runtime: context.api.runtime,
    resolvePath: context.api.resolvePath,
  });

  let taskId = normalized.taskId;
  let correlation: ContractHealth["outboundCorrelation"] = "missing";

  if (taskId) {
    correlation = "ok";
  } else if (normalized.chatId) {
    logContractMismatch(context, config, "message_sent missing taskId; falling back to weak correlation");
    taskId = (await service.findLatestDeliveringTaskByChat(normalized.chatId))?.taskId;
    correlation = taskId ? "weak" : "missing";
  }

  setContractObservation(context.api.runtime, "outboundCorrelation", correlation);

  if (!taskId) {
    logContractMismatch(context, config, "message_sent missing taskId and weak correlation did not resolve a task");
    return;
  }

  if (normalized.kind === "delivery_failed" || normalized.success === false) {
    await service.markDeliveryFailed(taskId, normalized.error ?? "Telegram delivery failed");
    return;
  }

  if (normalized.source !== undefined && normalized.source !== "async-return" && normalized.source !== "async-return-scheduler") {
    log(context, "debug", `message:sent task=${taskId} source="${normalized.source}" — not from async-return, skipping`);
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

export function normalizeMessageReceived(
  event: unknown,
  _runtime?: unknown,
): NormalizedMessageReceived | undefined {
  const record = asRecord(event);
  if (!record) return undefined;

  const context = pickRecord(record.context, record.ctx);
  const metadata = pickRecord(record.metadata, getRecord(context, "metadata"));

  return {
    channel: pickString(
      getValue(context, "channel"),
      getValue(context, "channelId"),
      getValue(metadata, "provider"),
      getValue(metadata, "surface"),
    ),
    chatId: pickId(
      getValue(context, "chatId"),
      getValue(context, "conversationId"),
      getValue(context, "to"),
      getValue(context, "from"),
      record.chatId,
      record.conversationId,
      record.to,
      getValue(metadata, "chatId"),
      getValue(metadata, "conversationId"),
      getValue(metadata, "senderId"),
      getValue(metadata, "to"),
      record.from,
    ),
    threadId: pickId(getValue(context, "threadId"), record.threadId, getValue(metadata, "threadId")),
    sessionId: pickId(getValue(context, "sessionId"), record.sessionId, getValue(metadata, "sessionId")),
    sessionKey: pickId(
      record.sessionKey,
      getValue(context, "sessionKey"),
      getValue(metadata, "sessionKey"),
      getValue(metadata, "senderId"),
      record.from,
    ),
    messageId: pickId(getValue(context, "messageId"), record.messageId, getValue(metadata, "messageId")),
    text: pickText(getValue(context, "text"), getValue(context, "content"), record.content, getValue(metadata, "text")),
    tags: pickStringArray(getValue(context, "tags"), getValue(metadata, "tags")) ?? [],
    asyncReturn: pickBoolean(getValue(context, "asyncReturn"), getValue(metadata, "asyncReturn")) ?? false,
    reply: pickReply(getValue(context, "reply"), record.reply),
    raw: event,
  };
}

export function normalizeAgentEnd(
  event: unknown,
  _runtime?: unknown,
): NormalizedAgentEnd | undefined {
  const record = asRecord(event);
  if (!record) return undefined;

  const context = pickRecord(record.context, record.ctx);
  const metadata = pickRecord(record.metadata, getRecord(context, "metadata"));
  const resultPayload = pickDefined(
    getValue(context, "resultPayload"),
    getValue(context, "result"),
    record.resultPayload,
    record.result,
    getValue(metadata, "resultPayload"),
  );
  const messages = pickArray(getValue(context, "messages"), record.messages);
  const success = pickBoolean(getValue(context, "success"), record.success, getValue(metadata, "success"));
  const error = pickString(getValue(context, "error"), record.error, getValue(metadata, "error"));
  let status = pickString(getValue(context, "status"), record.status, getValue(metadata, "status"));
  if (!status) {
    if (success === true) {
      status = "ok";
    } else if (success === false && error) {
      status = "error";
    } else {
      status = "unknown";
    }
  }

  return {
    taskId: pickId(getValue(context, "taskId"), record.taskId, getValue(metadata, "taskId")),
    chatId: pickId(
      getValue(context, "chatId"),
      getValue(context, "conversationId"),
      getValue(context, "to"),
      getValue(context, "from"),
      record.chatId,
      record.conversationId,
      record.to,
      getValue(metadata, "chatId"),
      getValue(metadata, "conversationId"),
      getValue(metadata, "senderId"),
      getValue(metadata, "to"),
      record.from,
    ),
    sessionId: pickId(getValue(context, "sessionId"), record.sessionId, getValue(metadata, "sessionId")),
    sessionKey: pickId(
      record.sessionKey,
      getValue(context, "sessionKey"),
      getValue(metadata, "sessionKey"),
      getValue(metadata, "senderId"),
      record.from,
    ),
    success,
    status,
    error,
    resultSummary: pickString(
      getValue(context, "resultSummary"),
      record.resultSummary,
      getValue(metadata, "resultSummary"),
      extractTextContent(resultPayload),
      extractFinalAssistantText(messages),
    ),
    resultPayload,
    raw: event,
  };
}

export function normalizeMessageSent(
  event: unknown,
  _runtime?: unknown,
): NormalizedMessageSent | undefined {
  const record = asRecord(event);
  if (!record) return undefined;

  const context = pickRecord(record.context, record.ctx);
  const metadata = pickRecord(record.metadata, getRecord(context, "metadata"));
  const contextMetadata = getRecord(context, "metadata");

  return {
    channel: pickString(
      getValue(context, "channel"),
      getValue(context, "channelId"),
      getValue(metadata, "provider"),
      getValue(metadata, "surface"),
    ),
    chatId: pickString(
      getValue(context, "chatId"),
      getValue(context, "conversationId"),
      getValue(context, "to"),
      getValue(metadata, "chatId"),
      getValue(metadata, "conversationId"),
      getValue(metadata, "senderId"),
      getValue(metadata, "to"),
      record.from as string | undefined,
    ),
    messageId: pickString(getValue(context, "messageId"), getValue(metadata, "messageId")),
    success: pickBoolean(getValue(context, "success"), getValue(metadata, "success")),
    error: pickString(getValue(context, "error"), getValue(metadata, "error")),
    taskId: pickString(
      getValue(context, "taskId"),
      getValue(contextMetadata, "taskId"),
      getValue(metadata, "taskId"),
    ),
    source: pickString(
      getValue(context, "source"),
      getValue(contextMetadata, "source"),
      getValue(metadata, "source"),
    ),
    kind: pickString(
      getValue(context, "kind"),
      getValue(contextMetadata, "kind"),
      getValue(metadata, "kind"),
    ),
    raw: event,
  };
}

export function extractFinalAssistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const role = pickString(message.role, message.type, getValue(message, "author"));
    if ((role ?? "").toLowerCase() !== "assistant") {
      continue;
    }
    const text = extractTextContent(message.content ?? message.text ?? message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function shouldTrackAsyncTask(
  event: NormalizedMessageReceived,
  config: TelegramAsyncReturnPluginConfig,
): TrackDecision {
  if (event.asyncReturn === true) {
    return { shouldTrack: true, reason: "asyncReturn" };
  }

  const tags = event.tags ?? [];
  if (tags.some((tag) => ["long-task", "async", "background"].includes(tag))) {
    return { shouldTrack: true, reason: "tag" };
  }

  if (config.trackAllMessages) {
    return { shouldTrack: true, reason: "trackAll" };
  }

  const text = (event.text ?? "").trim();
  const lowerText = text.toLowerCase();
  if (text && config.classification.keywordTriggers.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
    return { shouldTrack: true, reason: "keyword" };
  }

  const threshold = config.asyncTextLengthThreshold;
  if ((threshold > 0 && text.length >= threshold) || (config.classification.acceptPlainLongText && text.length > 0)) {
    return { shouldTrack: true, reason: "textLength" };
  }

  return { shouldTrack: false, reason: "none" };
}

function isTelegramNormalizedEvent(channel?: string) {
  const value = (channel ?? "").toLowerCase();
  return value === "telegram" || value === "tg";
}

function log<E>(context: HookContext<E>, level: "info" | "warn" | "error" | "debug", message: string) {
  const method = context.api.logger?.[level];
  if (typeof method === "function") {
    method(`[telegram-async-return] ${message}`);
  }
}

function logContractMismatch<E>(context: HookContext<E>, config: TelegramAsyncReturnPluginConfig, message: string) {
  if (!config.diagnostics.logContractMismatch) {
    return;
  }
  log(context, "warn", message);
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

function buildDeliverFn<E>(context: HookContext<E>) {
  const resolvedCfg = resolveTelegramAsyncReturnConfig(context.pluginConfig, context.api.resolvePath);
  let warnedMissing = false;
  return async (task: { taskId: string; chatId?: string; resultSummary?: string; resultPayload?: unknown }) => {
    const adapter = resolveSendAdapter({
      sendMessage: context.api.sendMessage,
      runtime: context.api.runtime,
      telegramBotToken: resolvedCfg.telegramBotToken,
    });

    if (!adapter.send) {
      if (!warnedMissing) {
        warnedMissing = true;
        log(context, "warn", `no supported send adapter available (adapter=${adapter.kind})`);
      }
      return false;
    }

    await adapter.send({
      chatId: task.chatId,
      text: task.resultSummary ?? JSON.stringify(task.resultPayload ?? "Task completed."),
      metadata: {
        taskId: task.taskId,
        source: "telegram-async-return",
        kind: "async_delivery",
      },
    });
    return true;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? asRecord(record[key]) : undefined;
}

function getValue(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record?.[key];
}

function pickRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }
  return undefined;
}

function pickDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickId(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function pickReply(...values: unknown[]): ((text: string) => Promise<void>) | undefined {
  for (const value of values) {
    if (typeof value === "function") {
      return value as (text: string) => Promise<void>;
    }
  }
  return undefined;
}

function pickArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function pickText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = extractTextContent(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function pickStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (strings.length > 0) {
      return strings;
    }
  }
  return undefined;
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => extractTextContent(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content;
  }
  if (typeof record.summary === "string" && record.summary.trim()) {
    return record.summary;
  }

  return undefined;
}
