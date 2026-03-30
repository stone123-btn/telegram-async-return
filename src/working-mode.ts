import type {
  CapabilityState,
  EventFormatFingerprint,
  TelegramAsyncReturnPluginConfig,
  WorkingMode,
} from "./types.js";

const WORKING_MODE_KEY = Symbol.for("openclaw.telegram-async-return.workingMode");

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === "object" && value !== null;
}

function getValue(record: unknown, key: string): unknown {
  if (!isRecord(record)) return undefined;
  return (record as Record<string, unknown>)[key];
}

function hasStringAt(record: unknown, key: string): boolean {
  const v = getValue(record, key);
  return typeof v === "string" && v.trim().length > 0;
}

export function analyzeEventFormat(event: unknown): EventFormatFingerprint {
  const record = isRecord(event) ? event as Record<string, unknown> : undefined;
  if (!record) {
    return { hasContext: false, hasMetadata: false };
  }

  const context = isRecord(record.context) ? record.context as Record<string, unknown> : undefined;
  const metadata = isRecord(record.metadata)
    ? record.metadata as Record<string, unknown>
    : (context && isRecord(getValue(context, "metadata"))
      ? getValue(context, "metadata") as Record<string, unknown>
      : undefined);

  const hasContext = context !== undefined;
  const hasMetadata = metadata !== undefined;

  const chatIdCandidates: Array<{ path: string; source: unknown; key: string }> = [
    { path: "context.chatId", source: context, key: "chatId" },
    { path: "context.conversationId", source: context, key: "conversationId" },
    { path: "context.to", source: context, key: "to" },
    { path: "context.from", source: context, key: "from" },
    { path: "metadata.chatId", source: metadata, key: "chatId" },
    { path: "metadata.conversationId", source: metadata, key: "conversationId" },
    { path: "metadata.senderId", source: metadata, key: "senderId" },
    { path: "metadata.to", source: metadata, key: "to" },
    { path: "event.from", source: record, key: "from" },
  ];

  const sessionKeyCandidates: Array<{ path: string; source: unknown; key: string }> = [
    { path: "event.sessionKey", source: record, key: "sessionKey" },
    { path: "context.sessionKey", source: context, key: "sessionKey" },
    { path: "metadata.sessionKey", source: metadata, key: "sessionKey" },
    { path: "metadata.senderId", source: metadata, key: "senderId" },
    { path: "event.from", source: record, key: "from" },
  ];

  const textCandidates: Array<{ path: string; source: unknown; key: string }> = [
    { path: "context.text", source: context, key: "text" },
    { path: "context.content", source: context, key: "content" },
    { path: "event.content", source: record, key: "content" },
    { path: "metadata.text", source: metadata, key: "text" },
  ];

  const channelCandidates: Array<{ path: string; source: unknown; key: string }> = [
    { path: "context.channel", source: context, key: "channel" },
    { path: "context.channelId", source: context, key: "channelId" },
    { path: "metadata.provider", source: metadata, key: "provider" },
    { path: "metadata.surface", source: metadata, key: "surface" },
  ];

  function findFirst(candidates: Array<{ path: string; source: unknown; key: string }>): string | undefined {
    for (const c of candidates) {
      if (hasStringAt(c.source, c.key)) {
        return c.path;
      }
    }
    return undefined;
  }

  return {
    hasContext,
    hasMetadata,
    chatIdPath: findFirst(chatIdCandidates),
    sessionKeyPath: findFirst(sessionKeyCandidates),
    textPath: findFirst(textCandidates),
    channelPath: findFirst(channelCandidates),
  };
}

export function ensureWorkingMode(runtime: unknown): WorkingMode {
  if (!isRecord(runtime)) {
    return createDefaultWorkingMode();
  }
  const r = runtime as Record<symbol, unknown>;
  let mode = r[WORKING_MODE_KEY] as WorkingMode | undefined;
  if (!mode) {
    mode = createDefaultWorkingMode();
    r[WORKING_MODE_KEY] = mode;
  }
  return mode;
}

export function getWorkingMode(runtime: unknown): WorkingMode | undefined {
  if (!isRecord(runtime)) return undefined;
  return (runtime as Record<symbol, unknown>)[WORKING_MODE_KEY] as WorkingMode | undefined;
}

export function initializeWorkingMode(
  runtime: unknown,
  event: unknown,
  config: TelegramAsyncReturnPluginConfig,
): WorkingMode {
  const mode = ensureWorkingMode(runtime);
  if (mode.initialized) {
    return mode;
  }

  mode.eventFormat = analyzeEventFormat(event);
  mode.probeStartedAt = Date.now();
  mode.probeExpired = false;
  mode.initialized = true;

  return mode;
}

export function recordCapability(
  runtime: unknown,
  capability: "agentEnd" | "messageSent",
): void {
  const mode = ensureWorkingMode(runtime);
  if (capability === "agentEnd") {
    mode.hasAgentEnd = "detected";
  } else {
    mode.hasMessageSent = "detected";
  }
}

export function checkProbeExpiry(
  runtime: unknown,
  config: TelegramAsyncReturnPluginConfig,
): void {
  const mode = ensureWorkingMode(runtime);
  if (mode.probeExpired || !mode.probeStartedAt) {
    return;
  }

  if (Date.now() - mode.probeStartedAt >= config.probeWindowMs) {
    if (mode.hasAgentEnd === "unknown") {
      mode.hasAgentEnd = "absent";
    }
    if (mode.hasMessageSent === "unknown") {
      mode.hasMessageSent = "absent";
    }
    mode.probeExpired = true;
  }
}

function createDefaultWorkingMode(): WorkingMode {
  return {
    initialized: false,
    hasAgentEnd: "unknown",
    hasMessageSent: "unknown",
    probeExpired: false,
  };
}
