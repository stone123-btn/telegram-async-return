export type AsyncTaskState =
  | "queued"
  | "running"
  | "waiting_delivery"
  | "delivering"
  | "delivered"
  | "failed"
  | "delivery_failed"
  | "cancelled";

export interface LoggerLike {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface RuntimeLike {
  [key: string | symbol]: unknown;
}

export interface TelegramAsyncReturnPluginConfig {
  enabled: boolean;
  storePath: string;
  runtimeBin: string;
  ackTemplate: string;
  ackOnAsyncStart: boolean;
  preferExistingTaskWindowSeconds: number;
  defaultStatusLookbackSeconds: number;
  autoResendOnDeliveryFailure: boolean;
  resend: {
    maxAttempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
  };
  recovery: {
    enabled: boolean;
    scanOnStartup: boolean;
    maxRecoveryTasks: number;
  };
  dedupe: {
    enabled: boolean;
    promptHash: boolean;
    replyToMessage: boolean;
    windowSeconds: number;
  };
  diagnostics: {
    logLifecycle: boolean;
    logDeliveryFailures: boolean;
    logRecovery: boolean;
  };
}

export interface AsyncTaskRecord {
  taskId: string;
  chatId?: string;
  threadId?: string;
  sessionId?: string;
  sourceMessageId?: string;
  prompt?: string;
  promptHash?: string;
  acknowledgement?: string;
  state: AsyncTaskState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  deliveredAt?: string;
  lastDeliveryAttemptAt?: string;
  ackSentAt?: string;
  deliveryAttempts: number;
  resultSummary?: string;
  resultPayload?: unknown;
  lastError?: string;
  metadata: Record<string, unknown>;
}

export interface CreateTelegramAsyncReturnServiceOptions {
  pluginConfig?: unknown;
  logger?: LoggerLike;
  runtime?: RuntimeLike;
  resolvePath?: (input: string) => string;
}

export interface TrackTaskInput {
  chatId?: string;
  threadId?: string;
  sessionId?: string;
  sourceMessageId?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export interface TrackTaskResult {
  task: AsyncTaskRecord;
  reused: boolean;
}

export interface CompleteTaskInput {
  taskId?: string;
  chatId?: string;
  sessionId?: string;
  success: boolean;
  resultSummary?: string;
  resultPayload?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskLookupInput {
  taskId?: string;
  chatId?: string;
  latest?: boolean;
  lookbackSeconds?: number;
}

export interface RecentTasksInput {
  chatId?: string;
  limit?: number;
  lookbackSeconds?: number;
}

export interface DiagnoseTaskResult {
  task?: AsyncTaskRecord;
  recommendedAction:
    | "none"
    | "wait"
    | "resend"
    | "repair"
    | "rerun"
    | "inspect_runtime";
  notes: string[];
}

export interface RepairChatResult {
  repairedTaskIds: string[];
  skippedTaskIds: string[];
}

export interface CommandResult {
  ok: boolean;
  action: string;
  message: string;
  data?: unknown;
}

export interface CommandContextLike {
  args?: string | string[];
  reply?: (message: string) => unknown | Promise<unknown>;
}

export interface HookContext {
  api: {
    logger?: LoggerLike;
    runtime?: RuntimeLike;
    resolvePath?: (input: string) => string;
  };
  event: unknown;
  pluginConfig?: unknown;
}
