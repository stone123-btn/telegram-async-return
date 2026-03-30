import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createTelegramAsyncReturnService } from "../src/service.js";
import { createDeliveryScheduler } from "../src/scheduler.js";
import { resolveTelegramAsyncReturnConfig } from "../src/config.js";
import type { TelegramAsyncReturnService } from "../src/service.js";

function tmpDir() {
  const dir = join(tmpdir(), `tar-sched-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeService(dir: string): TelegramAsyncReturnService {
  return createTelegramAsyncReturnService({
    pluginConfig: { storePath: join(dir, "store.db") },
    logger: {},
    runtime: {},
    resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
  });
}

describe("scheduler", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("runOnce delivers waiting_delivery tasks", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1", prompt: "hello" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true, resultSummary: "done" });

    const delivered: string[] = [];
    const scheduler = createDeliveryScheduler({
      service: svc,
      config: resolveTelegramAsyncReturnConfig({ storePath: join(dir, "store.db") }),
      deliver: async (t) => { delivered.push(t.taskId); return true; },
    });

    const result = await scheduler.runOnce();
    expect(result.scanned).toBe(1);
    expect(result.sentConfirmed).toContain(task.taskId);
    expect(delivered).toContain(task.taskId);

    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status?.state).toBe("sent_confirmed");
  });

  it("runOnce marks delivery_failed when deliver returns false", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config: resolveTelegramAsyncReturnConfig({ storePath: join(dir, "store.db") }),
      deliver: async () => false,
    });

    const result = await scheduler.runOnce();
    expect(result.failed).toContain(task.taskId);

    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status?.state).toBe("delivery_failed");
  });

  it("runOnce marks delivery_failed when deliver throws", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config: resolveTelegramAsyncReturnConfig({ storePath: join(dir, "store.db") }),
      deliver: async () => { throw new Error("network down"); },
    });

    const result = await scheduler.runOnce();
    expect(result.failed).toContain(task.taskId);

    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status?.state).toBe("delivery_failed");
    expect(status?.lastError).toBe("network down");
  });

  it("skips tasks that exceeded maxAttempts", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });

    const config = resolveTelegramAsyncReturnConfig({
      storePath: join(dir, "store.db"),
      resend: { maxAttempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: false },
    });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config,
      deliver: async () => false,
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    const result = await scheduler.runOnce();
    expect(result.skipped).toContain(task.taskId);
  });

  it("start/stop controls the running flag", () => {
    const svc = makeService(dir);
    const config = resolveTelegramAsyncReturnConfig({ storePath: join(dir, "store.db") });
    const scheduler = createDeliveryScheduler({
      service: svc,
      config,
      deliver: async () => true,
    });

    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it("delivers delivery_failed tasks on retry", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    await svc.resendTask(task.taskId);
    await svc.markDeliveryFailed(task.taskId, "first attempt failed");

    const config = resolveTelegramAsyncReturnConfig({
      storePath: join(dir, "store.db"),
      resend: { maxAttempts: 5, minDelayMs: 0, maxDelayMs: 0, jitter: false },
    });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config,
      deliver: async () => true,
    });

    const result = await scheduler.runOnce();
    expect(result.sentConfirmed).toContain(task.taskId);
  });

  it("runOnce expires timed-out tasks", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);

    const config = resolveTelegramAsyncReturnConfig({
      storePath: join(dir, "store.db"),
      maxTaskWaitMs: 0, // expire immediately
    });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config,
      deliver: async () => true,
    });

    const result = await scheduler.runOnce();
    expect(result.expired).toContain(task.taskId);

    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status?.state).toBe("failed");
  });

  it("runOnce cleans up completed_inline tasks", async () => {
    const svc = makeService(dir);
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.markCompletedInline(task.taskId, { resultSummary: "quick" });

    const config = resolveTelegramAsyncReturnConfig({
      storePath: join(dir, "store.db"),
      cleanupCompletedInline: true,
      completedInlineRetentionMs: 0, // clean up immediately
    });

    const scheduler = createDeliveryScheduler({
      service: svc,
      config,
      deliver: async () => true,
    });

    const result = await scheduler.runOnce();
    expect(result.cleaned).toBe(1);

    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status).toBeUndefined();
  });
});
