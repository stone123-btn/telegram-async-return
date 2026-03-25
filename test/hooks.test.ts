import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  handleGatewayStart,
  handleGatewayStop,
  handleMessageReceived,
  handleMessageSent,
  handleAgentEnd,
} from "../src/hooks.js";
import type {
  GatewayStartupEvent,
  GatewayShutdownEvent,
  MessageReceivedEvent,
  MessageSentEvent,
  AgentEndEvent,
  HookContext,
} from "../src/types.js";
import { createTelegramAsyncReturnService } from "../src/service.js";

function tmpDir() {
  const dir = join(tmpdir(), `tar-hooks-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePluginConfig(dir: string) {
  return {
    enabled: true,
    storePath: join(dir, "store.db"),
    ackOnAsyncStart: true,
    ackTemplate: "Processing...",
    asyncTextLengthThreshold: 120,
    autoResendOnDeliveryFailure: false,
    recovery: { enabled: false, scanOnStartup: false },
  };
}

function makeApi(dir: string) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {} as Record<string | symbol, unknown>,
    resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
  };
}

describe("hooks", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // handleGatewayStart
  // -----------------------------------------------------------------------

  describe("handleGatewayStart", () => {
    it("initializes without error", async () => {
      const context: HookContext<GatewayStartupEvent> = {
        api: makeApi(dir),
        event: { type: "gateway", action: "startup" },
        pluginConfig: makePluginConfig(dir),
      };
      await expect(handleGatewayStart(context)).resolves.toBeUndefined();
    });

    it("skips when disabled", async () => {
      const api = makeApi(dir);
      const context: HookContext<GatewayStartupEvent> = {
        api,
        event: { type: "gateway", action: "startup" },
        pluginConfig: { ...makePluginConfig(dir), enabled: false },
      };
      await handleGatewayStart(context);
      expect(api.logger.info).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // handleGatewayStop
  // -----------------------------------------------------------------------

  describe("handleGatewayStop", () => {
    it("stops without error", async () => {
      const context: HookContext<GatewayShutdownEvent> = {
        api: makeApi(dir),
        event: { type: "gateway", action: "shutdown" },
        pluginConfig: makePluginConfig(dir),
      };
      await expect(handleGatewayStop(context)).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // handleMessageReceived
  // -----------------------------------------------------------------------

  describe("handleMessageReceived", () => {
    function makeTelegramEvent(overrides?: Partial<MessageReceivedEvent["context"]>): MessageReceivedEvent {
      return {
        type: "message",
        action: "received",
        context: {
          channel: "telegram",
          chatId: "chat-123",
          text: "a".repeat(150), // long enough to trigger async tracking
          ...overrides,
        },
      };
    }

    it("tracks a telegram async task", async () => {
      const reply = vi.fn().mockResolvedValue(undefined);
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ reply }),
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
      expect(result!.task.chatId).toBe("chat-123");
      expect(result!.task.state).toBe("queued");
      expect(result!.reused).toBe(false);
      expect(reply).toHaveBeenCalledWith("Processing...");
    });

    it("skips non-telegram events", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ channel: "slack" }),
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
    });

    it("skips short messages without async markers", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ text: "hi" }),
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
    });

    it("tracks when asyncReturn flag is set", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ text: "hi", asyncReturn: true }),
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
      expect(result!.task.state).toBe("queued");
    });

    it("tracks when tags include async markers", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ text: "hi", tags: ["long-task"] }),
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
    });

    it("uses custom asyncTextLengthThreshold to capture shorter messages", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ text: "a".repeat(50) }),
        pluginConfig: { ...makePluginConfig(dir), asyncTextLengthThreshold: 40 },
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
      expect(result!.task.state).toBe("queued");
    });

    it("does not track long messages when asyncTextLengthThreshold is 0", async () => {
      const context: HookContext<MessageReceivedEvent> = {
        api: makeApi(dir),
        event: makeTelegramEvent({ text: "a".repeat(200) }),
        pluginConfig: { ...makePluginConfig(dir), asyncTextLengthThreshold: 0 },
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // handleMessageSent
  // -----------------------------------------------------------------------

  describe("handleMessageSent", () => {
    it("marks a task as delivered", async () => {
      // First create a tracked task
      const recvApi = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const recvCtx: HookContext<MessageReceivedEvent> = {
        api: recvApi,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      };
      const tracked = await handleMessageReceived(recvCtx);
      expect(tracked).toBeDefined();

      const sentEvent: MessageSentEvent = {
        type: "message",
        action: "sent",
        context: { channel: "telegram", taskId: tracked!.task.taskId },
      };
      const sentCtx: HookContext<MessageSentEvent> = {
        api: recvApi,
        event: sentEvent,
        pluginConfig: cfg,
      };
      await expect(handleMessageSent(sentCtx)).resolves.toBeUndefined();
    });

    it("marks delivery_failed", async () => {
      const recvApi = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const recvCtx: HookContext<MessageReceivedEvent> = {
        api: recvApi,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      };
      const tracked = await handleMessageReceived(recvCtx);

      const sentEvent: MessageSentEvent = {
        type: "message",
        action: "sent",
        context: {
          channel: "telegram",
          taskId: tracked!.task.taskId,
          kind: "delivery_failed",
          error: "timeout",
        },
      };
      const sentCtx: HookContext<MessageSentEvent> = {
        api: recvApi,
        event: sentEvent,
        pluginConfig: cfg,
      };
      await expect(handleMessageSent(sentCtx)).resolves.toBeUndefined();
    });

    it("skips when taskId is missing", async () => {
      const sentEvent: MessageSentEvent = {
        type: "message",
        action: "sent",
        context: { channel: "telegram" },
      };
      const ctx: HookContext<MessageSentEvent> = {
        api: makeApi(dir),
        event: sentEvent,
        pluginConfig: makePluginConfig(dir),
      };
      await expect(handleMessageSent(ctx)).resolves.toBeUndefined();
    });

    it("skips markDelivered when task is already delivered", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const recvCtx: HookContext<MessageReceivedEvent> = {
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      };
      const tracked = await handleMessageReceived(recvCtx);
      expect(tracked).toBeDefined();

      // Complete task and mark delivered via service directly
      const svc = createTelegramAsyncReturnService({
        pluginConfig: cfg,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      });
      await svc.completeTask({ taskId: tracked!.task.taskId, success: true });
      await svc.resendTask(tracked!.task.taskId);
      await svc.markDelivered(tracked!.task.taskId);

      // Now send a duplicate message:sent — should be skipped
      const sentCtx: HookContext<MessageSentEvent> = {
        api,
        event: {
          type: "message",
          action: "sent",
          context: { channel: "telegram", taskId: tracked!.task.taskId },
        },
        pluginConfig: cfg,
      };
      await handleMessageSent(sentCtx);

      const task = await svc.getStatus({ taskId: tracked!.task.taskId });
      expect(task?.state).toBe("delivered");
      expect(api.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("not deliverable, skipping"),
      );
    });

    it("skips markDelivered when task is still running", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const recvCtx: HookContext<MessageReceivedEvent> = {
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      };
      const tracked = await handleMessageReceived(recvCtx);
      expect(tracked).toBeDefined();

      // Task is in running state (startTask was called during handleMessageReceived)
      const svc = createTelegramAsyncReturnService({
        pluginConfig: cfg,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      });
      const taskBefore = await svc.getStatus({ taskId: tracked!.task.taskId });
      // startTask is called in handleMessageReceived, so it's either queued or running
      // The task was started so it should be running
      expect(["queued", "running"]).toContain(taskBefore?.state);

      const sentCtx: HookContext<MessageSentEvent> = {
        api,
        event: {
          type: "message",
          action: "sent",
          context: { channel: "telegram", taskId: tracked!.task.taskId },
        },
        pluginConfig: cfg,
      };
      await handleMessageSent(sentCtx);

      const taskAfter = await svc.getStatus({ taskId: tracked!.task.taskId });
      // Should still be in the same state, not delivered
      expect(taskAfter?.state).not.toBe("delivered");
      expect(api.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("not deliverable, skipping"),
      );
    });
  });

  // -----------------------------------------------------------------------
  // handleAgentEnd
  // -----------------------------------------------------------------------

  describe("handleAgentEnd", () => {
    it("completes a tracked task", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);

      // Create a task first
      const recvCtx: HookContext<MessageReceivedEvent> = {
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c2", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      };
      const tracked = await handleMessageReceived(recvCtx);
      expect(tracked).toBeDefined();

      const agentEvent: AgentEndEvent = {
        type: "agent",
        action: "end",
        context: {
          taskId: tracked!.task.taskId,
          chatId: "c2",
          status: "success",
          resultSummary: "Done!",
        },
      };
      const agentCtx: HookContext<AgentEndEvent> = {
        api,
        event: agentEvent,
        pluginConfig: cfg,
      };

      const result = await handleAgentEnd(agentCtx);
      expect(result).toBeDefined();
      expect(result!.taskId).toBe(tracked!.task.taskId);
    });

    it("returns undefined when no matching task", async () => {
      const agentEvent: AgentEndEvent = {
        type: "agent",
        action: "end",
        context: {
          taskId: "nonexistent-task",
          status: "success",
        },
      };
      const ctx: HookContext<AgentEndEvent> = {
        api: makeApi(dir),
        event: agentEvent,
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleAgentEnd(ctx);
      expect(result).toBeUndefined();
    });

    it("skips when disabled", async () => {
      const api = makeApi(dir);
      const agentEvent: AgentEndEvent = {
        type: "agent",
        action: "end",
        context: { taskId: "t1", status: "success" },
      };
      const ctx: HookContext<AgentEndEvent> = {
        api,
        event: agentEvent,
        pluginConfig: { ...makePluginConfig(dir), enabled: false },
      };

      await handleAgentEnd(ctx);
      expect(api.logger.info).not.toHaveBeenCalled();
    });
  });
});
