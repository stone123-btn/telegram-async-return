import { describe, it, expect } from "vitest";
import {
  analyzeEventFormat,
  initializeWorkingMode,
  ensureWorkingMode,
  recordCapability,
  checkProbeExpiry,
  getWorkingMode,
} from "../src/working-mode.js";
import type { TelegramAsyncReturnPluginConfig } from "../src/types.js";
import { resolveTelegramAsyncReturnConfig } from "../src/config.js";

function makeConfig(overrides?: Partial<TelegramAsyncReturnPluginConfig>): TelegramAsyncReturnPluginConfig {
  return resolveTelegramAsyncReturnConfig({ ...overrides });
}

describe("working-mode", () => {
  describe("analyzeEventFormat", () => {
    it("detects flat metadata format", () => {
      const event = {
        metadata: {
          provider: "telegram",
          senderId: "u123",
          text: "hello",
        },
      };
      const fp = analyzeEventFormat(event);
      expect(fp.hasContext).toBe(false);
      expect(fp.hasMetadata).toBe(true);
      expect(fp.chatIdPath).toBe("metadata.senderId");
      expect(fp.channelPath).toBe("metadata.provider");
      expect(fp.textPath).toBe("metadata.text");
    });

    it("detects context-based format", () => {
      const event = {
        context: {
          channel: "telegram",
          chatId: "c1",
          text: "hi",
        },
      };
      const fp = analyzeEventFormat(event);
      expect(fp.hasContext).toBe(true);
      expect(fp.hasMetadata).toBe(false);
      expect(fp.chatIdPath).toBe("context.chatId");
      expect(fp.channelPath).toBe("context.channel");
      expect(fp.textPath).toBe("context.text");
    });

    it("detects mixed context+metadata format", () => {
      const event = {
        sessionKey: "sk-1",
        context: {
          conversationId: "conv-1",
          content: "hi there",
        },
        metadata: {
          provider: "telegram",
          sessionId: "s-1",
        },
      };
      const fp = analyzeEventFormat(event);
      expect(fp.hasContext).toBe(true);
      expect(fp.hasMetadata).toBe(true);
      expect(fp.chatIdPath).toBe("context.conversationId");
      expect(fp.channelPath).toBe("metadata.provider");
      expect(fp.textPath).toBe("context.content");
      expect(fp.sessionKeyPath).toBe("event.sessionKey");
    });

    it("handles empty event", () => {
      const fp = analyzeEventFormat({});
      expect(fp.hasContext).toBe(false);
      expect(fp.hasMetadata).toBe(false);
      expect(fp.chatIdPath).toBeUndefined();
    });

    it("handles null event", () => {
      const fp = analyzeEventFormat(null);
      expect(fp.hasContext).toBe(false);
      expect(fp.hasMetadata).toBe(false);
    });
  });

  describe("initializeWorkingMode", () => {
    it("initializes on first call", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig();
      const event = { context: { channel: "telegram", chatId: "c1" } };

      const mode = initializeWorkingMode(runtime, event, config);
      expect(mode.initialized).toBe(true);
      expect(mode.eventFormat).toBeDefined();
      expect(mode.eventFormat!.chatIdPath).toBe("context.chatId");
      expect(mode.probeStartedAt).toBeDefined();
      expect(mode.probeExpired).toBe(false);
    });

    it("is idempotent — does not re-analyze on second call", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig();

      const event1 = { context: { channel: "telegram", chatId: "c1" } };
      const mode1 = initializeWorkingMode(runtime, event1, config);
      const probeStart = mode1.probeStartedAt;

      const event2 = { metadata: { provider: "telegram", senderId: "u1" } };
      const mode2 = initializeWorkingMode(runtime, event2, config);

      expect(mode2.probeStartedAt).toBe(probeStart);
      expect(mode2.eventFormat!.chatIdPath).toBe("context.chatId");
    });
  });

  describe("recordCapability", () => {
    it("records agentEnd capability", () => {
      const runtime: Record<string | symbol, unknown> = {};
      ensureWorkingMode(runtime);
      recordCapability(runtime, "agentEnd");
      const mode = getWorkingMode(runtime);
      expect(mode?.hasAgentEnd).toBe("detected");
    });

    it("records messageSent capability", () => {
      const runtime: Record<string | symbol, unknown> = {};
      ensureWorkingMode(runtime);
      recordCapability(runtime, "messageSent");
      const mode = getWorkingMode(runtime);
      expect(mode?.hasMessageSent).toBe("detected");
    });
  });

  describe("checkProbeExpiry", () => {
    it("marks unknown capabilities as absent after probe window", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig({ probeWindowMs: 0 });
      const mode = ensureWorkingMode(runtime);
      mode.probeStartedAt = Date.now() - 1;

      checkProbeExpiry(runtime, config);
      expect(mode.hasAgentEnd).toBe("absent");
      expect(mode.hasMessageSent).toBe("absent");
      expect(mode.probeExpired).toBe(true);
    });

    it("does not overwrite detected capabilities", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig({ probeWindowMs: 0 });
      const mode = ensureWorkingMode(runtime);
      mode.probeStartedAt = Date.now() - 1;
      mode.hasAgentEnd = "detected";

      checkProbeExpiry(runtime, config);
      expect(mode.hasAgentEnd).toBe("detected");
      expect(mode.hasMessageSent).toBe("absent");
    });

    it("does nothing if probe window has not expired", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig({ probeWindowMs: 60000 });
      const mode = ensureWorkingMode(runtime);
      mode.probeStartedAt = Date.now();

      checkProbeExpiry(runtime, config);
      expect(mode.hasAgentEnd).toBe("unknown");
      expect(mode.hasMessageSent).toBe("unknown");
      expect(mode.probeExpired).toBe(false);
    });

    it("does nothing if already expired", () => {
      const runtime: Record<string | symbol, unknown> = {};
      const config = makeConfig({ probeWindowMs: 0 });
      const mode = ensureWorkingMode(runtime);
      mode.probeStartedAt = Date.now() - 1;
      mode.probeExpired = true;
      mode.hasAgentEnd = "unknown"; // should NOT change since probeExpired is already true

      checkProbeExpiry(runtime, config);
      expect(mode.hasAgentEnd).toBe("unknown"); // not touched because probeExpired was already true
    });
  });
});
