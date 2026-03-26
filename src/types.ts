export type AsyncTaskState =
  | "queued"
  | "running"
  | "waiting_delivery"
  | "delivering"
  | "sent_confirmed"
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

export type SendMessageFn = (msg: {
  chatId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

export type SendAdapterKind =
  | "api.sendMessage"
  | "runtime.telegram.sendMessageTelegram"
  | "none";

export interface ResolvedSendAdapter {
  kind: SendAdapterKind;
  send?: SendMessageFn;
}

export interface TelegramAsyncReturnPluginConfig {
  enabled: boolean;
  storePath: string;
  runtimeBin: string;
  ackTemplate: string;
  ackOnAsyncStart: boolean;
  asyncTextLengthThreshold: number;
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
    logContractMismatch: boolean;
    explainClassification: boolean;
  };
  classification: {
    keywordTriggers: string[];
    acceptPlainLongText: boolean;
  };
}

export interface AsyncTaskRecord {
  taskId: string;
  chatId?: string;
  threadId?: string;
  sessionId?: string;
  sessionKey?: string;
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
  sessionKey?: string;
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
  sessionKey?: string;
  success: boolean;
  resultSummary?: string;
  resultPayload?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskLookupInput {
  taskId?: string;
  chatId?: string;
  sessionId?: string;
  sessionKey?: string;
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
    | "inspect_runtime"
    | "inspect_inbound_classification";
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

export type ContractObservation = "unseen" | "ok" | "weak" | "missing";
export type ClassificationMode = "explicit_only" | "threshold_fallback" | "hybrid";

export interface ContractHealth {
  inboundNormalization: ContractObservation;
  agentCompletionCorrelation: ContractObservation;
  outboundCorrelation: ContractObservation;
  classification: ClassificationMode;
  deliverySignal: "host_send_ack";
  sendAdapter?: SendAdapterKind;
}

export interface RawOpenClawEvent {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawGatewayStartupEvent extends RawOpenClawEvent {}
export interface RawGatewayShutdownEvent extends RawOpenClawEvent {}
export interface RawMessageReceivedEvent extends RawOpenClawEvent {}
export interface RawMessageSentEvent extends RawOpenClawEvent {}
export interface RawAgentEndEvent extends RawOpenClawEvent {}

export interface NormalizedMessageReceived {
  channel?: string;
  chatId?: string;
  threadId?: string;
  sessionId?: string;
  sessionKey?: string;
  messageId?: string;
  text?: string;
  tags?: string[];
  asyncReturn?: boolean;
  reply?: (text: string) => Promise<void>;
  raw?: unknown;
}

export interface NormalizedAgentEnd {
  taskId?: string;
  chatId?: string;
  sessionId?: string;
  sessionKey?: string;
  status?: string;
  success?: boolean;
  error?: string;
  resultSummary?: string;
  resultPayload?: unknown;
  raw?: unknown;
}

export interface NormalizedMessageSent {
  channel?: string;
  chatId?: string;
  messageId?: string;
  success?: boolean;
  error?: string;
  taskId?: string;
  source?: string;
  kind?: string;
  raw?: unknown;
}

export interface HookContext<E = unknown> {
  api: {
    logger?: LoggerLike;
    runtime?: RuntimeLike;
    resolvePath?: (input: string) => string;
    sendMessage?: SendMessageFn;
  };
  event: E;
  pluginConfig?: unknown;
}
