import type {
  AsyncTaskRecord,
  LoggerLike,
  TelegramAsyncReturnPluginConfig,
} from "./types.js";
import type { TelegramAsyncReturnService } from "./service.js";

export type DeliverFn = (task: AsyncTaskRecord) => Promise<boolean>;

export interface DeliverySchedulerOptions {
  service: TelegramAsyncReturnService;
  config: TelegramAsyncReturnPluginConfig;
  deliver: DeliverFn;
  logger?: LoggerLike;
}

export interface DeliveryScheduler {
  start(): void;
  stop(): void;
  runOnce(): Promise<DeliveryRunResult>;
  readonly running: boolean;
}

export interface DeliveryRunResult {
  scanned: number;
  delivered: string[];
  failed: string[];
  skipped: string[];
}

export function createDeliveryScheduler(options: DeliverySchedulerOptions): DeliveryScheduler {
  const { service, config, deliver, logger } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let _running = false;

  function computeDelay(attempts: number): number {
    const { minDelayMs, maxDelayMs, jitter } = config.resend;
    const exponential = Math.min(minDelayMs * Math.pow(2, attempts), maxDelayMs);
    if (!jitter) return exponential;
    return exponential * (0.5 + Math.random() * 0.5);
  }

  function isReadyForRetry(task: AsyncTaskRecord): boolean {
    if (task.deliveryAttempts >= config.resend.maxAttempts) return false;
    if (!task.lastDeliveryAttemptAt) return true;

    const delay = computeDelay(task.deliveryAttempts);
    const nextAttemptAt = Date.parse(task.lastDeliveryAttemptAt) + delay;
    return Date.now() >= nextAttemptAt;
  }

  async function runOnce(): Promise<DeliveryRunResult> {
    if (inFlight) {
      return { scanned: 0, delivered: [], failed: [], skipped: [] };
    }

    inFlight = true;
    const result: DeliveryRunResult = {
      scanned: 0,
      delivered: [],
      failed: [],
      skipped: [],
    };

    try {
      const candidates = await service.pendingDeliveryTasks(config.defaultStatusLookbackSeconds);

      result.scanned = candidates.length;

      for (const task of candidates) {
        if (!isReadyForRetry(task)) {
          result.skipped.push(task.taskId);
          continue;
        }

        if (task.deliveryAttempts >= config.resend.maxAttempts) {
          result.skipped.push(task.taskId);
          continue;
        }

        await service.resendTask(task.taskId);

        try {
          const ok = await deliver(task);
          if (ok) {
            await service.markDelivered(task.taskId);
            result.delivered.push(task.taskId);
            log("info", `delivered ${task.taskId}`);
          } else {
            await service.markDeliveryFailed(task.taskId, "deliver() returned false");
            result.failed.push(task.taskId);
            log("warn", `delivery returned false for ${task.taskId} — runtime.sendTelegramMessage may not be registered`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          await service.markDeliveryFailed(task.taskId, message);
          result.failed.push(task.taskId);
          log("error", `delivery error for ${task.taskId}: ${message}`);
        }
      }
    } finally {
      inFlight = false;
    }

    return result;
  }

  function start() {
    if (_running) return;
    _running = true;
    const intervalMs = config.resend.minDelayMs || 5000;
    timer = setInterval(() => {
      runOnce().catch((err: unknown) => {
        log("error", `scheduler tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    log("info", `delivery scheduler started (interval=${intervalMs}ms)`);
  }

  function stop() {
    if (!_running) return;
    _running = false;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    log("info", "delivery scheduler stopped");
  }

  function log(level: "info" | "warn" | "error" | "debug", message: string) {
    const method = logger?.[level];
    if (typeof method === "function") {
      method(`[async-return-scheduler] ${message}`);
    }
  }

  return {
    start,
    stop,
    runOnce,
    get running() {
      return _running;
    },
  };
}
