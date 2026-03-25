import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveTelegramAsyncReturnConfig } from "./config.js";
import type {
  AsyncTaskRecord,
  AsyncTaskState,
  CompleteTaskInput,
  CreateTelegramAsyncReturnServiceOptions,
  DiagnoseTaskResult,
  RecentTasksInput,
  RepairChatResult,
  TaskLookupInput,
  TelegramAsyncReturnPluginConfig,
  TrackTaskInput,
  TrackTaskResult,
} from "./types.js";

const SERVICE_RUNTIME_KEY = Symbol.for("openclaw.telegram-async-return.service");
const ACTIVE_STATES: AsyncTaskState[] = ["queued", "running", "waiting_delivery", "delivering"];
const DELIVERY_STATES: AsyncTaskState[] = ["waiting_delivery", "delivering", "delivery_failed"];

// ---------------------------------------------------------------------------
// Public service interface (unchanged from JSON version)
// ---------------------------------------------------------------------------

export interface TelegramAsyncReturnService {
  id: string;
  name: string;
  config: TelegramAsyncReturnPluginConfig;
  health(): Promise<{ ok: boolean; storePath: string; runtimeBin: string; enabled: boolean }>;
  trackTask(input: TrackTaskInput): Promise<TrackTaskResult>;
  startTask(taskId: string): Promise<AsyncTaskRecord | undefined>;
  acknowledgeTask(taskId: string, acknowledgement?: string): Promise<AsyncTaskRecord | undefined>;
  completeTask(input: CompleteTaskInput): Promise<AsyncTaskRecord | undefined>;
  getStatus(input: TaskLookupInput): Promise<AsyncTaskRecord | undefined>;
  recentTasks(input: RecentTasksInput): Promise<AsyncTaskRecord[]>;
  resendTask(taskId: string): Promise<AsyncTaskRecord | undefined>;
  markDelivered(taskId: string): Promise<AsyncTaskRecord | undefined>;
  markDeliveryFailed(taskId: string, error: string): Promise<AsyncTaskRecord | undefined>;
  diagnoseTask(input: TaskLookupInput): Promise<DiagnoseTaskResult>;
  repairChat(chatId: string): Promise<RepairChatResult>;
  recoverPendingTasks(): Promise<RepairChatResult>;
  pendingDeliveryTasks(lookbackSeconds?: number): Promise<AsyncTaskRecord[]>;
}

// ---------------------------------------------------------------------------
// SQLite row shape
// ---------------------------------------------------------------------------

interface TaskRow {
  task_id: string;
  chat_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  source_message_id: string | null;
  prompt: string | null;
  prompt_hash: string | null;
  acknowledgement: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  last_delivery_attempt_at: string | null;
  ack_sent_at: string | null;
  delivery_attempts: number;
  result_summary: string | null;
  result_payload: string | null;
  last_error: string | null;
  metadata: string;
}

// ---------------------------------------------------------------------------
// SQLite-backed implementation
// ---------------------------------------------------------------------------

class SqliteTelegramAsyncReturnService implements TelegramAsyncReturnService {
  id = "telegram-async-return";
  name = "Telegram Async Return";
  config: TelegramAsyncReturnPluginConfig;

  private readonly logger?: CreateTelegramAsyncReturnServiceOptions["logger"];
  private db: Database.Database;

  constructor(private readonly options: CreateTelegramAsyncReturnServiceOptions) {
    this.config = resolveTelegramAsyncReturnConfig(options.pluginConfig, options.resolvePath);
    this.logger = options.logger;
    this.db = this.openDatabase();
    this.migrate();
  }

  // ---- public API --------------------------------------------------------

  async health() {
    return {
      ok: this.config.enabled,
      storePath: this.config.storePath,
      runtimeBin: this.config.runtimeBin,
      enabled: this.config.enabled,
    };
  }

  async trackTask(input: TrackTaskInput): Promise<TrackTaskResult> {
    const reusable = this.findReusableTask(input);
    if (reusable) {
      this.updateTimestamp(reusable.taskId);
      return { task: { ...reusable, updatedAt: this.now() }, reused: true };
    }

    const timestamp = this.now();
    const taskId = this.createTaskId(input.chatId);
    const promptHash = input.prompt ? this.hashPrompt(input.prompt) : null;

    const task: AsyncTaskRecord = {
      taskId,
      chatId: input.chatId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId,
      prompt: input.prompt,
      promptHash: promptHash ?? undefined,
      acknowledgement: this.config.ackTemplate,
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveryAttempts: 0,
      metadata: { ...(input.metadata ?? {}) },
    };

    this.insertTask(task);
    this.log("info", `tracked async task ${taskId}`);
    return { task, reused: false };
  }

  async startTask(taskId: string) {
    const task = this.getTaskById(taskId);
    if (!task) return undefined;

    const timestamp = this.now();
    this.db.prepare(`
      UPDATE async_tasks
      SET state = 'running',
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE task_id = ?
    `).run(timestamp, timestamp, taskId);

    return this.getTaskById(taskId);
  }

  async acknowledgeTask(taskId: string, acknowledgement?: string) {
    const task = this.getTaskById(taskId);
    if (!task) return undefined;

    const ack = acknowledgement ?? task.acknowledgement ?? this.config.ackTemplate;
    const timestamp = this.now();

    this.db.prepare(`
      UPDATE async_tasks
      SET acknowledgement = ?,
          ack_sent_at = ?,
          updated_at = ?
      WHERE task_id = ?
    `).run(ack, timestamp, timestamp, taskId);

    return this.getTaskById(taskId);
  }

  async completeTask(input: CompleteTaskInput) {
    const task = this.findTask(input);
    if (!task) return undefined;

    const timestamp = this.now();
    const newState: AsyncTaskState = input.success ? "waiting_delivery" : "failed";
    const lastError = input.success ? null : (input.error ?? "Task execution failed");
    const metadata = { ...task.metadata, ...(input.metadata ?? {}) };

    this.db.prepare(`
      UPDATE async_tasks
      SET state = ?,
          updated_at = ?,
          completed_at = ?,
          result_summary = COALESCE(?, result_summary),
          result_payload = COALESCE(?, result_payload),
          last_error = ?,
          metadata = ?
      WHERE task_id = ?
    `).run(
      newState,
      timestamp,
      timestamp,
      input.resultSummary ?? null,
      input.resultPayload != null ? JSON.stringify(input.resultPayload) : null,
      lastError,
      JSON.stringify(metadata),
      task.taskId,
    );

    return this.getTaskById(task.taskId);
  }

  async getStatus(input: TaskLookupInput) {
    return this.findTask(input);
  }

  async recentTasks(input: RecentTasksInput) {
    const lookbackSeconds = input.lookbackSeconds ?? this.config.defaultStatusLookbackSeconds;
    const cutoff = new Date(Date.now() - lookbackSeconds * 1000).toISOString();
    const limit = input.limit ?? 10;

    let rows: TaskRow[];
    if (input.chatId) {
      rows = this.db.prepare(`
        SELECT * FROM async_tasks
        WHERE chat_id = ? AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(input.chatId, cutoff, limit) as TaskRow[];
    } else {
      rows = this.db.prepare(`
        SELECT * FROM async_tasks
        WHERE updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(cutoff, limit) as TaskRow[];
    }

    return rows.map(rowToRecord);
  }

  async resendTask(taskId: string) {
    const task = this.getTaskById(taskId);
    if (!task) return undefined;

    const timestamp = this.now();
    this.db.prepare(`
      UPDATE async_tasks
      SET state = 'delivering',
          delivery_attempts = delivery_attempts + 1,
          last_delivery_attempt_at = ?,
          updated_at = ?
      WHERE task_id = ?
    `).run(timestamp, timestamp, taskId);

    return this.getTaskById(taskId);
  }

  async markDelivered(taskId: string) {
    const task = this.getTaskById(taskId);
    if (!task) return undefined;

    const timestamp = this.now();
    this.db.prepare(`
      UPDATE async_tasks
      SET state = 'delivered',
          delivered_at = ?,
          updated_at = ?
      WHERE task_id = ?
    `).run(timestamp, timestamp, taskId);

    return this.getTaskById(taskId);
  }

  async markDeliveryFailed(taskId: string, error: string) {
    const task = this.getTaskById(taskId);
    if (!task) return undefined;

    const timestamp = this.now();
    this.db.prepare(`
      UPDATE async_tasks
      SET state = 'delivery_failed',
          last_error = ?,
          updated_at = ?,
          last_delivery_attempt_at = ?
      WHERE task_id = ?
    `).run(error, timestamp, timestamp, taskId);

    return this.getTaskById(taskId);
  }

  async diagnoseTask(input: TaskLookupInput): Promise<DiagnoseTaskResult> {
    const task = this.findTask(input);
    if (!task) {
      return {
        recommendedAction: "inspect_runtime",
        notes: ["No tracked task matches the provided lookup."],
      };
    }

    if (task.state === "running" || task.state === "queued") {
      return { task, recommendedAction: "wait", notes: ["Task is still in progress.", "Do not rerun yet."] };
    }

    if (task.state === "waiting_delivery" || task.state === "delivering") {
      return { task, recommendedAction: "resend", notes: ["Execution finished.", "Delivery is still pending or in progress."] };
    }

    if (task.state === "delivery_failed") {
      return { task, recommendedAction: "repair", notes: ["Execution finished but delivery failed.", "Resend or repair is appropriate."] };
    }

    if (task.state === "failed") {
      return { task, recommendedAction: "rerun", notes: ["Execution itself failed."] };
    }

    return { task, recommendedAction: "none", notes: ["Task is already delivered or cancelled."] };
  }

  async repairChat(chatId: string): Promise<RepairChatResult> {
    const timestamp = this.now();
    const placeholders = DELIVERY_STATES.map(() => "?").join(",");

    const candidates = this.db.prepare(`
      SELECT task_id, state FROM async_tasks
      WHERE chat_id = ?
    `).all(chatId) as { task_id: string; state: string }[];

    const repairedTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    const update = this.db.prepare(`
      UPDATE async_tasks
      SET state = 'waiting_delivery', updated_at = ?
      WHERE task_id = ? AND state IN (${placeholders})
    `);

    for (const row of candidates) {
      if (DELIVERY_STATES.includes(row.state as AsyncTaskState)) {
        update.run(timestamp, row.task_id, ...DELIVERY_STATES);
        repairedTaskIds.push(row.task_id);
      } else {
        skippedTaskIds.push(row.task_id);
      }
    }

    return { repairedTaskIds, skippedTaskIds };
  }

  async recoverPendingTasks(): Promise<RepairChatResult> {
    const timestamp = this.now();

    const deliveringRows = this.db.prepare(`
      SELECT task_id FROM async_tasks WHERE state = 'delivering'
    `).all() as { task_id: string }[];

    this.db.prepare(`
      UPDATE async_tasks
      SET state = 'waiting_delivery', updated_at = ?
      WHERE state = 'delivering'
    `).run(timestamp);

    const repairedTaskIds = deliveringRows.map((r) => r.task_id);

    const activePlaceholders = ACTIVE_STATES.map(() => "?").join(",");
    const skippedRows = this.db.prepare(`
      SELECT task_id FROM async_tasks
      WHERE (state IN (${activePlaceholders}) OR state = 'delivery_failed')
        AND state != 'delivering'
    `).all(...ACTIVE_STATES) as { task_id: string }[];

    const skippedTaskIds = skippedRows.map((r) => r.task_id);
    return { repairedTaskIds, skippedTaskIds };
  }

  async pendingDeliveryTasks(lookbackSeconds?: number): Promise<AsyncTaskRecord[]> {
    const seconds = lookbackSeconds ?? this.config.defaultStatusLookbackSeconds;
    const cutoff = new Date(Date.now() - seconds * 1000).toISOString();
    const states: AsyncTaskState[] = ["waiting_delivery", "delivery_failed"];
    const rows = this.db.prepare(`
      SELECT * FROM async_tasks
      WHERE state IN (?, ?)
        AND updated_at >= ?
      ORDER BY updated_at ASC
    `).all(...states, cutoff) as TaskRow[];
    return rows.map(rowToRecord);
  }

  // ---- private: database -------------------------------------------------

  private openDatabase(): Database.Database {
    const storePath = this.config.storePath;
    const parentDirectory = getParentDirectory(storePath);
    if (parentDirectory) {
      mkdirSync(parentDirectory, { recursive: true });
    }

    const db = new Database(storePath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    return db;
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS async_tasks (
        task_id                 TEXT PRIMARY KEY,
        chat_id                 TEXT,
        thread_id               TEXT,
        session_id              TEXT,
        source_message_id       TEXT,
        prompt                  TEXT,
        prompt_hash             TEXT,
        acknowledgement         TEXT,
        state                   TEXT NOT NULL DEFAULT 'queued',
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        started_at              TEXT,
        completed_at            TEXT,
        delivered_at            TEXT,
        last_delivery_attempt_at TEXT,
        ack_sent_at             TEXT,
        delivery_attempts       INTEGER NOT NULL DEFAULT 0,
        result_summary          TEXT,
        result_payload          TEXT,
        last_error              TEXT,
        metadata                TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_chat_id    ON async_tasks(chat_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_state      ON async_tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON async_tasks(updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON async_tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_prompt_hash ON async_tasks(prompt_hash);
    `);
  }

  // ---- private: CRUD helpers ---------------------------------------------

  private insertTask(task: AsyncTaskRecord) {
    this.db.prepare(`
      INSERT INTO async_tasks (
        task_id, chat_id, thread_id, session_id, source_message_id,
        prompt, prompt_hash, acknowledgement, state,
        created_at, updated_at, delivery_attempts, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.taskId,
      task.chatId ?? null,
      task.threadId ?? null,
      task.sessionId ?? null,
      task.sourceMessageId ?? null,
      task.prompt ?? null,
      task.promptHash ?? null,
      task.acknowledgement ?? null,
      task.state,
      task.createdAt,
      task.updatedAt,
      task.deliveryAttempts,
      JSON.stringify(task.metadata),
    );
  }

  private getTaskById(taskId: string): AsyncTaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM async_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private updateTimestamp(taskId: string) {
    this.db.prepare("UPDATE async_tasks SET updated_at = ? WHERE task_id = ?").run(this.now(), taskId);
  }

  private findTask(input: TaskLookupInput | CompleteTaskInput): AsyncTaskRecord | undefined {
    if (input.taskId) {
      return this.getTaskById(input.taskId);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.chatId) {
      conditions.push("chat_id = ?");
      params.push(input.chatId);
    }

    if ("sessionId" in input && input.sessionId) {
      conditions.push("session_id = ?");
      params.push(input.sessionId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.prepare(`
      SELECT * FROM async_tasks ${where} ORDER BY updated_at DESC LIMIT 1
    `).get(...params) as TaskRow | undefined;

    return row ? rowToRecord(row) : undefined;
  }

  private findReusableTask(input: TrackTaskInput): AsyncTaskRecord | undefined {
    if (!this.config.dedupe.enabled || !input.chatId) {
      return undefined;
    }

    const cutoff = new Date(Date.now() - this.config.dedupe.windowSeconds * 1000).toISOString();
    const reusableStates = [...ACTIVE_STATES];
    const placeholders = reusableStates.map(() => "?").join(",");

    const rows = this.db.prepare(`
      SELECT * FROM async_tasks
      WHERE chat_id = ?
        AND updated_at >= ?
        AND state IN (${placeholders})
      ORDER BY updated_at DESC
    `).all(input.chatId, cutoff, ...reusableStates) as TaskRow[];

    const promptHash = input.prompt && this.config.dedupe.promptHash ? this.hashPrompt(input.prompt) : undefined;

    for (const row of rows) {
      if (this.config.dedupe.replyToMessage && input.sourceMessageId && row.source_message_id === input.sourceMessageId) {
        return rowToRecord(row);
      }

      if (promptHash && row.prompt_hash === promptHash) {
        return rowToRecord(row);
      }
    }

    return undefined;
  }

  // ---- private: helpers --------------------------------------------------

  private createTaskId(chatId?: string) {
    const chatPart = chatId ? chatId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) : "task";
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${chatPart}-${timePart}-${randomPart}`;
  }

  private hashPrompt(prompt: string) {
    let hash = 0;
    for (const character of prompt) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash.toString(36);
  }

  private now() {
    return new Date().toISOString();
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string) {
    const method = this.logger?.[level];
    if (typeof method === "function") {
      method(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Row <-> Record mapping
// ---------------------------------------------------------------------------

function rowToRecord(row: TaskRow): AsyncTaskRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch { /* keep empty */ }

  let resultPayload: unknown;
  if (row.result_payload) {
    try {
      resultPayload = JSON.parse(row.result_payload);
    } catch {
      resultPayload = row.result_payload;
    }
  }

  return {
    taskId: row.task_id,
    chatId: row.chat_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    prompt: row.prompt ?? undefined,
    promptHash: row.prompt_hash ?? undefined,
    acknowledgement: row.acknowledgement ?? undefined,
    state: row.state as AsyncTaskRecord["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at ?? undefined,
    ackSentAt: row.ack_sent_at ?? undefined,
    deliveryAttempts: row.delivery_attempts,
    resultSummary: row.result_summary ?? undefined,
    resultPayload,
    lastError: row.last_error ?? undefined,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Factory (singleton per runtime, same as before)
// ---------------------------------------------------------------------------

export function createTelegramAsyncReturnService(
  options: CreateTelegramAsyncReturnServiceOptions,
): TelegramAsyncReturnService {
  const runtime = options.runtime;
  const existing = isRecord(runtime) ? runtime[SERVICE_RUNTIME_KEY] : undefined;
  if (isService(existing)) {
    return existing;
  }

  const service = new SqliteTelegramAsyncReturnService(options);
  if (isRecord(runtime)) {
    runtime[SERVICE_RUNTIME_KEY] = service;
  }

  return service;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getParentDirectory(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === "object" && value !== null;
}

function isService(value: unknown): value is TelegramAsyncReturnService {
  return typeof value === "object" && value !== null && "trackTask" in value && "health" in value;
}
