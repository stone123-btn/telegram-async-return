import { resolve, isAbsolute } from "node:path";
import type { TelegramAsyncReturnPluginConfig } from "./types.js";

const DEFAULT_CONFIG: TelegramAsyncReturnPluginConfig = {
  enabled: true,
  storePath: ".openclaw/telegram-async-return/store.db",
  runtimeBin: "openclaw-telegram-async-return",
  telegramBotToken: "",
  ackTemplate: "已接收，任务会在后台继续处理。完成后我会自动把结果发回这里。",
  ackOnAsyncStart: true,
  asyncTextLengthThreshold: 0,
  preferExistingTaskWindowSeconds: 900,
  defaultStatusLookbackSeconds: 86400,
  autoResendOnDeliveryFailure: true,
  resend: {
    maxAttempts: 5,
    minDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
  },
  recovery: {
    enabled: true,
    scanOnStartup: true,
    maxRecoveryTasks: 100,
  },
  dedupe: {
    enabled: true,
    promptHash: true,
    replyToMessage: true,
    windowSeconds: 900,
  },
  diagnostics: {
    logLifecycle: false,
    logDeliveryFailures: true,
    logRecovery: true,
    logContractMismatch: true,
    explainClassification: true,
  },
  classification: {
    keywordTriggers: [],
    acceptPlainLongText: false,
  },
};

const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: DEFAULT_CONFIG.enabled },
    storePath: { type: "string", default: DEFAULT_CONFIG.storePath },
    runtimeBin: { type: "string", default: DEFAULT_CONFIG.runtimeBin },
    telegramBotToken: { type: "string", default: DEFAULT_CONFIG.telegramBotToken },
    ackTemplate: { type: "string", default: DEFAULT_CONFIG.ackTemplate },
    ackOnAsyncStart: { type: "boolean", default: DEFAULT_CONFIG.ackOnAsyncStart },
    asyncTextLengthThreshold: {
      type: "number",
      minimum: 0,
      default: DEFAULT_CONFIG.asyncTextLengthThreshold,
    },
    preferExistingTaskWindowSeconds: {
      type: "number",
      minimum: 0,
      default: DEFAULT_CONFIG.preferExistingTaskWindowSeconds,
    },
    defaultStatusLookbackSeconds: {
      type: "number",
      minimum: 0,
      default: DEFAULT_CONFIG.defaultStatusLookbackSeconds,
    },
    autoResendOnDeliveryFailure: {
      type: "boolean",
      default: DEFAULT_CONFIG.autoResendOnDeliveryFailure,
    },
    resend: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxAttempts: {
          type: "number",
          minimum: 1,
          default: DEFAULT_CONFIG.resend.maxAttempts,
        },
        minDelayMs: {
          type: "number",
          minimum: 0,
          default: DEFAULT_CONFIG.resend.minDelayMs,
        },
        maxDelayMs: {
          type: "number",
          minimum: 0,
          default: DEFAULT_CONFIG.resend.maxDelayMs,
        },
        jitter: {
          type: "boolean",
          default: DEFAULT_CONFIG.resend.jitter,
        },
      },
    },
    recovery: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: DEFAULT_CONFIG.recovery.enabled,
        },
        scanOnStartup: {
          type: "boolean",
          default: DEFAULT_CONFIG.recovery.scanOnStartup,
        },
        maxRecoveryTasks: {
          type: "number",
          minimum: 1,
          default: DEFAULT_CONFIG.recovery.maxRecoveryTasks,
        },
      },
    },
    dedupe: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: DEFAULT_CONFIG.dedupe.enabled,
        },
        promptHash: {
          type: "boolean",
          default: DEFAULT_CONFIG.dedupe.promptHash,
        },
        replyToMessage: {
          type: "boolean",
          default: DEFAULT_CONFIG.dedupe.replyToMessage,
        },
        windowSeconds: {
          type: "number",
          minimum: 0,
          default: DEFAULT_CONFIG.dedupe.windowSeconds,
        },
      },
    },
    diagnostics: {
      type: "object",
      additionalProperties: false,
      properties: {
        logLifecycle: {
          type: "boolean",
          default: DEFAULT_CONFIG.diagnostics.logLifecycle,
        },
        logDeliveryFailures: {
          type: "boolean",
          default: DEFAULT_CONFIG.diagnostics.logDeliveryFailures,
        },
        logRecovery: {
          type: "boolean",
          default: DEFAULT_CONFIG.diagnostics.logRecovery,
        },
        logContractMismatch: {
          type: "boolean",
          default: DEFAULT_CONFIG.diagnostics.logContractMismatch,
        },
        explainClassification: {
          type: "boolean",
          default: DEFAULT_CONFIG.diagnostics.explainClassification,
        },
      },
    },
    classification: {
      type: "object",
      additionalProperties: false,
      properties: {
        keywordTriggers: {
          type: "array",
          items: { type: "string" },
          default: DEFAULT_CONFIG.classification.keywordTriggers,
        },
        acceptPlainLongText: {
          type: "boolean",
          default: DEFAULT_CONFIG.classification.acceptPlainLongText,
        },
      },
    },
  },
};

export function createTelegramAsyncReturnConfigSchema() {
  return JSON.parse(JSON.stringify(CONFIG_SCHEMA));
}

export function resolveTelegramAsyncReturnConfig(
  pluginConfig: unknown,
  resolvePath?: (input: string) => string,
): TelegramAsyncReturnPluginConfig {
  const input = isRecord(pluginConfig) ? pluginConfig : {};

  const config: TelegramAsyncReturnPluginConfig = {
    enabled: readBoolean(input.enabled, DEFAULT_CONFIG.enabled),
    storePath: resolveConfiguredPath(readString(input.storePath, DEFAULT_CONFIG.storePath), resolvePath),
    runtimeBin: readString(input.runtimeBin, DEFAULT_CONFIG.runtimeBin),
    telegramBotToken: readString(input.telegramBotToken, DEFAULT_CONFIG.telegramBotToken),
    ackTemplate: readString(input.ackTemplate, DEFAULT_CONFIG.ackTemplate),
    ackOnAsyncStart: readBoolean(input.ackOnAsyncStart, DEFAULT_CONFIG.ackOnAsyncStart),
    asyncTextLengthThreshold: readNumber(
      input.asyncTextLengthThreshold,
      DEFAULT_CONFIG.asyncTextLengthThreshold,
    ),
    preferExistingTaskWindowSeconds: readNumber(
      input.preferExistingTaskWindowSeconds,
      DEFAULT_CONFIG.preferExistingTaskWindowSeconds,
    ),
    defaultStatusLookbackSeconds: readNumber(
      input.defaultStatusLookbackSeconds,
      DEFAULT_CONFIG.defaultStatusLookbackSeconds,
    ),
    autoResendOnDeliveryFailure: readBoolean(
      input.autoResendOnDeliveryFailure,
      DEFAULT_CONFIG.autoResendOnDeliveryFailure,
    ),
    resend: {
      maxAttempts: readNumber(readNested(input, "resend", "maxAttempts"), DEFAULT_CONFIG.resend.maxAttempts),
      minDelayMs: readNumber(readNested(input, "resend", "minDelayMs"), DEFAULT_CONFIG.resend.minDelayMs),
      maxDelayMs: readNumber(readNested(input, "resend", "maxDelayMs"), DEFAULT_CONFIG.resend.maxDelayMs),
      jitter: readBoolean(readNested(input, "resend", "jitter"), DEFAULT_CONFIG.resend.jitter),
    },
    recovery: {
      enabled: readBoolean(readNested(input, "recovery", "enabled"), DEFAULT_CONFIG.recovery.enabled),
      scanOnStartup: readBoolean(
        readNested(input, "recovery", "scanOnStartup"),
        DEFAULT_CONFIG.recovery.scanOnStartup,
      ),
      maxRecoveryTasks: readNumber(
        readNested(input, "recovery", "maxRecoveryTasks"),
        DEFAULT_CONFIG.recovery.maxRecoveryTasks,
      ),
    },
    dedupe: {
      enabled: readBoolean(readNested(input, "dedupe", "enabled"), DEFAULT_CONFIG.dedupe.enabled),
      promptHash: readBoolean(
        readNested(input, "dedupe", "promptHash"),
        DEFAULT_CONFIG.dedupe.promptHash,
      ),
      replyToMessage: readBoolean(
        readNested(input, "dedupe", "replyToMessage"),
        DEFAULT_CONFIG.dedupe.replyToMessage,
      ),
      windowSeconds: readNumber(
        readNested(input, "dedupe", "windowSeconds"),
        DEFAULT_CONFIG.dedupe.windowSeconds,
      ),
    },
    diagnostics: {
      logLifecycle: readBoolean(
        readNested(input, "diagnostics", "logLifecycle"),
        DEFAULT_CONFIG.diagnostics.logLifecycle,
      ),
      logDeliveryFailures: readBoolean(
        readNested(input, "diagnostics", "logDeliveryFailures"),
        DEFAULT_CONFIG.diagnostics.logDeliveryFailures,
      ),
      logRecovery: readBoolean(
        readNested(input, "diagnostics", "logRecovery"),
        DEFAULT_CONFIG.diagnostics.logRecovery,
      ),
      logContractMismatch: readBoolean(
        readNested(input, "diagnostics", "logContractMismatch"),
        DEFAULT_CONFIG.diagnostics.logContractMismatch,
      ),
      explainClassification: readBoolean(
        readNested(input, "diagnostics", "explainClassification"),
        DEFAULT_CONFIG.diagnostics.explainClassification,
      ),
    },
    classification: {
      keywordTriggers: readStringArray(
        readNested(input, "classification", "keywordTriggers"),
        DEFAULT_CONFIG.classification.keywordTriggers,
      ),
      acceptPlainLongText: readBoolean(
        readNested(input, "classification", "acceptPlainLongText"),
        DEFAULT_CONFIG.classification.acceptPlainLongText,
      ),
    },
  };

  if (config.resend.maxDelayMs < config.resend.minDelayMs) {
    config.resend.maxDelayMs = config.resend.minDelayMs;
  }

  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNested(record: Record<string, unknown>, parentKey: string, key: string) {
  const parent = record[parentKey];
  if (!isRecord(parent)) {
    return undefined;
  }

  return parent[key];
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function resolveConfiguredPath(pathValue: string, resolvePath?: (input: string) => string) {
  if (resolvePath) {
    return resolvePath(pathValue);
  }
  return isAbsolute(pathValue) ? pathValue : resolve(pathValue);
}
