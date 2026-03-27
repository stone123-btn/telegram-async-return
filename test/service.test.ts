import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createTelegramAsyncReturnService } from "../src/service.js";
import type { TelegramAsyncReturnService } from "../src/service.js";

function tmpDir() {
  const dir = join(tmpdir(), `tar-test-${randomBytes(6).toString("hex")}`);
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

describe("service", () => {
  let dir: string;
  let svc: TelegramAsyncReturnService;

  beforeEach(() => {
    dir = tmpDir();
    svc = makeService(dir);
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("health returns ok when enabled", async () => {
    const h = await svc.health();
    expect(h.ok).toBe(true);
    expect(h.enabled).toBe(true);
    expect(h.storePath).toContain("store.db");
  });

  it("trackTask creates a new task in queued state", async () => {
    const result = await svc.trackTask({ chatId: "c1", prompt: "hello" });
    expect(result.reused).toBe(false);
    expect(result.task.state).toBe("queued");
    expect(result.task.chatId).toBe("c1");
    expect(result.task.taskId).toBeTruthy();
  });

  it("startTask transitions to running", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    const started = await svc.startTask(task.taskId);
    expect(started?.state).toBe("running");
    expect(started?.startedAt).toBeTruthy();
  });

  it("acknowledgeTask records ack timestamp", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    const acked = await svc.acknowledgeTask(task.taskId, "Got it");
    expect(acked?.acknowledgement).toBe("Got it");
    expect(acked?.ackSentAt).toBeTruthy();
  });

  it("completeTask success sets waiting_delivery", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    const done = await svc.completeTask({
      taskId: task.taskId,
      success: true,
      resultSummary: "All done",
    });
    expect(done?.state).toBe("waiting_delivery");
    expect(done?.resultSummary).toBe("All done");
  });

  it("completeTask failure sets failed", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    const done = await svc.completeTask({
      taskId: task.taskId,
      success: false,
      error: "boom",
    });
    expect(done?.state).toBe("failed");
    expect(done?.lastError).toBe("boom");
  });

  it("getStatus finds task by taskId", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    const found = await svc.getStatus({ taskId: task.taskId });
    expect(found?.taskId).toBe(task.taskId);
  });

  it("getStatus finds latest task by chatId", async () => {
    await svc.trackTask({ chatId: "c1", prompt: "first" });
    // ensure second task has a later updated_at
    await new Promise((r) => setTimeout(r, 15));
    const { task: t2 } = await svc.trackTask({ chatId: "c1", prompt: "second" });
    const found = await svc.getStatus({ chatId: "c1", latest: true });
    expect(found?.taskId).toBe(t2.taskId);
  });

  it("recentTasks returns tasks ordered by updatedAt desc", async () => {
    const { task: t1 } = await svc.trackTask({ chatId: "c1", prompt: "a" });
    // ensure second task has a later updated_at
    await new Promise((r) => setTimeout(r, 15));
    const { task: t2 } = await svc.trackTask({ chatId: "c1", prompt: "b" });
    const recent = await svc.recentTasks({ chatId: "c1" });
    expect(recent.length).toBe(2);
    expect(recent[0]!.taskId).toBe(t2.taskId);
    expect(recent[1]!.taskId).toBe(t1.taskId);
  });

  it("resendTask increments delivery_attempts and sets delivering", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    const resent = await svc.resendTask(task.taskId);
    expect(resent?.state).toBe("delivering");
    expect(resent?.deliveryAttempts).toBe(1);
  });

  it("markSentConfirmed sets sent_confirmed state", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    await svc.resendTask(task.taskId);
    const delivered = await svc.markSentConfirmed(task.taskId);
    expect(delivered?.state).toBe("sent_confirmed");
    expect(delivered?.deliveredAt).toBeTruthy();
  });

  it("markDeliveryFailed sets delivery_failed state", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    await svc.resendTask(task.taskId);
    const failed = await svc.markDeliveryFailed(task.taskId, "net error");
    expect(failed?.state).toBe("delivery_failed");
    expect(failed?.lastError).toBe("net error");
  });

  it("dedupe reuses active task with same promptHash", async () => {
    const r1 = await svc.trackTask({ chatId: "c1", prompt: "same prompt" });
    const r2 = await svc.trackTask({ chatId: "c1", prompt: "same prompt" });
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(true);
    expect(r2.task.taskId).toBe(r1.task.taskId);
  });

  it("dedupe reuses by sourceMessageId", async () => {
    const r1 = await svc.trackTask({ chatId: "c1", sourceMessageId: "m1", prompt: "a" });
    const r2 = await svc.trackTask({ chatId: "c1", sourceMessageId: "m1", prompt: "b" });
    expect(r2.reused).toBe(true);
    expect(r2.task.taskId).toBe(r1.task.taskId);
  });

  it("diagnoseTask recommends wait for running task", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    const diag = await svc.diagnoseTask({ taskId: task.taskId });
    expect(diag.recommendedAction).toBe("wait");
  });

  it("diagnoseTask recommends inspect_runtime for waiting_delivery without send adapter", async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const isolatedSvc = createTelegramAsyncReturnService({
        pluginConfig: { storePath: join(dir, "store-no-token.db"), telegramBotToken: "" },
        logger: {},
        runtime: {},
        resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
      });
      const { task } = await isolatedSvc.trackTask({ chatId: "c1" });
      await isolatedSvc.startTask(task.taskId);
      await isolatedSvc.completeTask({ taskId: task.taskId, success: true });
      const diag = await isolatedSvc.diagnoseTask({ taskId: task.taskId });
      expect(diag.recommendedAction).toBe("inspect_runtime");
    } finally {
      if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    }
  });

  it("diagnoseTask recommends resend for waiting_delivery with send adapter", async () => {
    const svcWithSend = createTelegramAsyncReturnService({
      pluginConfig: { storePath: join(dir, "store-send.db") },
      logger: {},
      runtime: { telegram: { sendMessageTelegram: async () => {} } },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
    });
    const { task } = await svcWithSend.trackTask({ chatId: "c1" });
    await svcWithSend.startTask(task.taskId);
    await svcWithSend.completeTask({ taskId: task.taskId, success: true });
    const diag = await svcWithSend.diagnoseTask({ taskId: task.taskId });
    expect(diag.recommendedAction).toBe("resend");
  });

  it("diagnoseTask recommends rerun for failed", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: false, error: "err" });
    const diag = await svc.diagnoseTask({ taskId: task.taskId });
    expect(diag.recommendedAction).toBe("rerun");
  });

  it("diagnoseTask recommends inspect_inbound_classification when no task exists", async () => {
    const diag = await svc.diagnoseTask({ chatId: "missing-chat" });
    expect(diag.recommendedAction).toBe("inspect_inbound_classification");
    expect(diag.notes[0]).toContain("No recent tracked task");
  });

  it("repairChat resets delivery states to waiting_delivery", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    await svc.resendTask(task.taskId);
    await svc.markDeliveryFailed(task.taskId, "err");
    const repair = await svc.repairChat("c1");
    expect(repair.repairedTaskIds).toContain(task.taskId);
  });

  it("recoverPendingTasks resets delivering to waiting_delivery", async () => {
    const { task } = await svc.trackTask({ chatId: "c1" });
    await svc.startTask(task.taskId);
    await svc.completeTask({ taskId: task.taskId, success: true });
    await svc.resendTask(task.taskId);
    const recovery = await svc.recoverPendingTasks();
    expect(recovery.repairedTaskIds).toContain(task.taskId);
    const status = await svc.getStatus({ taskId: task.taskId });
    expect(status?.state).toBe("waiting_delivery");
  });

  it("pendingDeliveryTasks returns only waiting_delivery and delivery_failed tasks", async () => {
    const { task: t1 } = await svc.trackTask({ chatId: "c1", prompt: "one" });
    await svc.startTask(t1.taskId);
    await svc.completeTask({ taskId: t1.taskId, success: true });
    // t1 is now waiting_delivery

    const { task: t2 } = await svc.trackTask({ chatId: "c1", prompt: "two" });
    await svc.startTask(t2.taskId);
    await svc.completeTask({ taskId: t2.taskId, success: true });
    await svc.resendTask(t2.taskId);
    await svc.markDeliveryFailed(t2.taskId, "err");
    // t2 is now delivery_failed

    const { task: t3 } = await svc.trackTask({ chatId: "c1", prompt: "three" });
    await svc.startTask(t3.taskId);
    // t3 is running

    const { task: t4 } = await svc.trackTask({ chatId: "c1", prompt: "four" });
    await svc.startTask(t4.taskId);
    await svc.completeTask({ taskId: t4.taskId, success: true });
    await svc.resendTask(t4.taskId);
    await svc.markSentConfirmed(t4.taskId);
    // t4 is sent_confirmed

    const pending = await svc.pendingDeliveryTasks();
    const ids = pending.map((t) => t.taskId);
    expect(ids).toContain(t1.taskId);
    expect(ids).toContain(t2.taskId);
    expect(ids).not.toContain(t3.taskId);
    expect(ids).not.toContain(t4.taskId);
  });

  it("sent_confirmed tasks are not reused by dedupe", async () => {
    const r1 = await svc.trackTask({ chatId: "c1", prompt: "same prompt" });
    await svc.startTask(r1.task.taskId);
    await svc.completeTask({ taskId: r1.task.taskId, success: true });
    await svc.resendTask(r1.task.taskId);
    await svc.markSentConfirmed(r1.task.taskId);
    // r1 is now sent_confirmed

    const r2 = await svc.trackTask({ chatId: "c1", prompt: "same prompt" });
    expect(r2.reused).toBe(false);
    expect(r2.task.taskId).not.toBe(r1.task.taskId);
  });

  it("dedupe.windowSeconds expiry prevents reuse", async () => {
    // Create service with a 1-second dedupe window
    const shortSvc = createTelegramAsyncReturnService({
      pluginConfig: {
        storePath: join(dir, "store-short.db"),
        dedupe: { windowSeconds: 1 },
      },
      logger: {},
      runtime: {},
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
    });

    const r1 = await shortSvc.trackTask({ chatId: "c1", prompt: "same prompt" });
    expect(r1.reused).toBe(false);

    // Wait for dedupe window to expire
    await new Promise((r) => setTimeout(r, 1100));

    const r2 = await shortSvc.trackTask({ chatId: "c1", prompt: "same prompt" });
    expect(r2.reused).toBe(false);
    expect(r2.task.taskId).not.toBe(r1.task.taskId);
  });

  it("completeTask with no identifiers returns undefined", async () => {
    const done = await svc.completeTask({ success: true, resultSummary: "noop" });
    expect(done).toBeUndefined();
  });

  it("findLatestActiveTaskBySession returns newest active task", async () => {
    const first = await svc.trackTask({ chatId: "c1", sessionId: "s1", prompt: "first" });
    await svc.startTask(first.task.taskId);
    await new Promise((r) => setTimeout(r, 15));
    const second = await svc.trackTask({ chatId: "c1", sessionId: "s1", prompt: "second" });
    await svc.startTask(second.task.taskId);

    const found = await svc.findLatestActiveTaskBySession("s1");
    expect(found?.taskId).toBe(second.task.taskId);
  });

  it("findLatestDeliveringTaskByChat returns newest deliverable task", async () => {
    const tracked = await svc.trackTask({ chatId: "c9", prompt: "deliver me" });
    await svc.startTask(tracked.task.taskId);
    await svc.completeTask({ taskId: tracked.task.taskId, success: true });

    const found = await svc.findLatestDeliveringTaskByChat("c9");
    expect(found?.taskId).toBe(tracked.task.taskId);
    expect(found?.state).toBe("waiting_delivery");
  });
});
