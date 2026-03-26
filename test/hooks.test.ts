import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  getContractHealth,
  handleAgentEnd,
  handleGatewayStart,
  handleGatewayStop,
  handleMessageReceived,
  handleMessageSent,
} from "../src/hooks.js";
import type { HookContext } from "../src/types.js";
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

  describe("gateway hooks", () => {
    it("handleGatewayStart initializes without error", async () => {
      const context: HookContext = {
        api: makeApi(dir),
        event: { type: "gateway", action: "startup" },
        pluginConfig: makePluginConfig(dir),
      };
      await expect(handleGatewayStart(context)).resolves.toBeUndefined();
    });

    it("handleGatewayStop stops without error", async () => {
      const context: HookContext = {
        api: makeApi(dir),
        event: { type: "gateway", action: "shutdown" },
        pluginConfig: makePluginConfig(dir),
      };
      await expect(handleGatewayStop(context)).resolves.toBeUndefined();
    });
  });

  describe("handleMessageReceived", () => {
    it("tracks telegram async task from raw event", async () => {
      const reply = vi.fn().mockResolvedValue(undefined);
      const api = makeApi(dir);
      const context: HookContext = {
        api,
        event: {
          type: "message",
          action: "received",
          context: {
            channel: "telegram",
            chatId: "chat-123",
            text: "a".repeat(150),
            reply,
          },
        },
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
      expect(result!.task.chatId).toBe("chat-123");
      expect(result!.task.state).toBe("queued");
      expect(reply).toHaveBeenCalledWith("Processing...");

      const contractHealth = getContractHealth(api.runtime);
      expect(contractHealth?.inboundNormalization).toBe("ok");
    });

    it("normalizes alternate host shape from metadata/provider fields", async () => {
      const context: HookContext = {
        api: makeApi(dir),
        event: {
          type: "message",
          action: "received",
          sessionKey: "sess-key-1",
          context: {
            conversationId: "chat-456",
            content: "a".repeat(140),
          },
          metadata: {
            provider: "telegram",
            sessionId: "sess-456",
            messageId: "msg-1",
          },
        },
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeDefined();
      expect(result!.task.chatId).toBe("chat-456");
      expect(result!.task.sessionId).toBe("sess-456");
      expect(result!.task.sessionKey).toBe("sess-key-1");
    });

    it("skips non-telegram events", async () => {
      const context: HookContext = {
        api: makeApi(dir),
        event: {
          type: "message",
          action: "received",
          context: { channel: "slack", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
    });

    it("does not track plain messages when threshold is 0", async () => {
      const api = makeApi(dir);
      const context: HookContext = {
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(200) },
        },
        pluginConfig: { ...makePluginConfig(dir), asyncTextLengthThreshold: 0 },
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
      expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("not tracked"));
    });

    it("logs contract mismatch when inbound normalization misses identifiers", async () => {
      const api = makeApi(dir);
      const context: HookContext = {
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", text: "a".repeat(150) },
        },
        pluginConfig: makePluginConfig(dir),
      };

      const result = await handleMessageReceived(context);
      expect(result).toBeUndefined();
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing chatId/sessionId/sessionKey"),
      );
      expect(getContractHealth(api.runtime)?.inboundNormalization).toBe("missing");
    });
  });

  describe("handleMessageSent", () => {
    it("marks task as sent_confirmed with direct taskId correlation", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const tracked = await handleMessageReceived({
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      });
      const svc = createTelegramAsyncReturnService({
        pluginConfig: cfg,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      });
      await svc.completeTask({ taskId: tracked!.task.taskId, success: true });
      await svc.resendTask(tracked!.task.taskId);

      await handleMessageSent({
        api,
        event: {
          type: "message",
          action: "sent",
          context: { channel: "telegram", taskId: tracked!.task.taskId },
        },
        pluginConfig: cfg,
      });

      const status = await svc.getStatus({ taskId: tracked!.task.taskId });
      expect(status?.state).toBe("sent_confirmed");
      expect(getContractHealth(api.runtime)?.outboundCorrelation).toBe("ok");
    });

    it("falls back to weak correlation by chatId when taskId is missing", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const tracked = await handleMessageReceived({
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      });
      const svc = createTelegramAsyncReturnService({
        pluginConfig: cfg,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      });
      await svc.completeTask({ taskId: tracked!.task.taskId, success: true });
      await svc.resendTask(tracked!.task.taskId);

      await handleMessageSent({
        api,
        event: {
          type: "message",
          action: "sent",
          context: { channel: "telegram", chatId: "c1" },
        },
        pluginConfig: cfg,
      });

      const status = await svc.getStatus({ taskId: tracked!.task.taskId });
      expect(status?.state).toBe("sent_confirmed");
      expect(getContractHealth(api.runtime)?.outboundCorrelation).toBe("weak");
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to weak correlation"),
      );
    });

    it("marks delivery_failed when message:sent reports failure", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const tracked = await handleMessageReceived({
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c1", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      });
      const svc = createTelegramAsyncReturnService({
        pluginConfig: cfg,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      });
      await svc.completeTask({ taskId: tracked!.task.taskId, success: true });
      await svc.resendTask(tracked!.task.taskId);

      await handleMessageSent({
        api,
        event: {
          type: "message",
          action: "sent",
          context: {
            channel: "telegram",
            taskId: tracked!.task.taskId,
            kind: "delivery_failed",
            error: "timeout",
          },
        },
        pluginConfig: cfg,
      });

      const status = await svc.getStatus({ taskId: tracked!.task.taskId });
      expect(status?.state).toBe("delivery_failed");
      expect(status?.lastError).toBe("timeout");
    });
  });

  describe("handleAgentEnd", () => {
    it("completes task through direct taskId correlation", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const tracked = await handleMessageReceived({
        api,
        event: {
          type: "message",
          action: "received",
          context: { channel: "telegram", chatId: "c2", text: "a".repeat(150) },
        },
        pluginConfig: cfg,
      });

      const result = await handleAgentEnd({
        api,
        event: {
          type: "agent",
          action: "end",
          context: {
            taskId: tracked!.task.taskId,
            chatId: "c2",
            success: true,
            resultSummary: "Done!",
          },
        },
        pluginConfig: cfg,
      });

      expect(result).toBeDefined();
      expect(result!.taskId).toBe(tracked!.task.taskId);
      expect(result!.state).toBe("waiting_delivery");
      expect(getContractHealth(api.runtime)?.agentCompletionCorrelation).toBe("ok");
    });

    it("falls back by sessionId and extracts final assistant text from messages", async () => {
      const api = makeApi(dir);
      const cfg = makePluginConfig(dir);
      const tracked = await handleMessageReceived({
        api,
        event: {
          type: "message",
          action: "received",
          context: {
            channel: "telegram",
            chatId: "c3",
            sessionId: "sess-3",
            text: "a".repeat(150),
          },
        },
        pluginConfig: cfg,
      });

      const result = await handleAgentEnd({
        api,
        event: {
          type: "agent",
          action: "end",
          context: {
            sessionId: "sess-3",
            success: true,
            messages: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "final answer" },
            ],
          },
        },
        pluginConfig: cfg,
      });

      expect(result).toBeDefined();
      expect(result!.taskId).toBe(tracked!.task.taskId);
      expect(result!.resultSummary).toBe("final answer");
      expect(getContractHealth(api.runtime)?.agentCompletionCorrelation).toBe("ok");
    });

    it("logs contract mismatch when identifiers are missing", async () => {
      const api = makeApi(dir);
      const result = await handleAgentEnd({
        api,
        event: {
          type: "agent",
          action: "end",
          context: {
            success: true,
            resultSummary: "done",
          },
        },
        pluginConfig: makePluginConfig(dir),
      });

      expect(result).toBeUndefined();
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("agent_end missing correlation identifiers"),
      );
      expect(getContractHealth(api.runtime)?.agentCompletionCorrelation).toBe("missing");
    });
  });
});
