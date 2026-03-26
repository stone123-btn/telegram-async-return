import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveSendAdapter } from "../src/host-send.js";

describe("resolveSendAdapter", () => {
  it("returns api.sendMessage when provided", () => {
    const send = vi.fn();
    const adapter = resolveSendAdapter({ sendMessage: send });
    expect(adapter.kind).toBe("api.sendMessage");
    expect(adapter.send).toBe(send);
  });

  it("returns runtime.telegram.sendMessageTelegram when available", () => {
    const sendMessageTelegram = vi.fn();
    const adapter = resolveSendAdapter({
      runtime: { telegram: { sendMessageTelegram } },
    });
    expect(adapter.kind).toBe("runtime.telegram.sendMessageTelegram");
    expect(adapter.send).toBeDefined();
  });

  it("returns config.telegramBotToken when token is provided and no higher-priority adapter", () => {
    const adapter = resolveSendAdapter({
      telegramBotToken: "123:ABC",
    });
    expect(adapter.kind).toBe("config.telegramBotToken");
    expect(adapter.send).toBeDefined();
  });

  it("prefers api.sendMessage over telegramBotToken", () => {
    const send = vi.fn();
    const adapter = resolveSendAdapter({
      sendMessage: send,
      telegramBotToken: "123:ABC",
    });
    expect(adapter.kind).toBe("api.sendMessage");
  });

  it("prefers runtime.telegram over telegramBotToken", () => {
    const sendMessageTelegram = vi.fn();
    const adapter = resolveSendAdapter({
      runtime: { telegram: { sendMessageTelegram } },
      telegramBotToken: "123:ABC",
    });
    expect(adapter.kind).toBe("runtime.telegram.sendMessageTelegram");
  });

  it("returns none when nothing is available", () => {
    const adapter = resolveSendAdapter({});
    expect(adapter.kind).toBe("none");
    expect(adapter.send).toBeUndefined();
  });

  it("returns none when telegramBotToken is empty string", () => {
    const adapter = resolveSendAdapter({ telegramBotToken: "" });
    expect(adapter.kind).toBe("none");
  });

  it("bot token send throws when chatId is missing", async () => {
    const adapter = resolveSendAdapter({ telegramBotToken: "123:ABC" });
    await expect(adapter.send!({ text: "hello" })).rejects.toThrow("chatId is required");
  });

  it("bot token send calls fetch with correct URL and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = resolveSendAdapter({ telegramBotToken: "123:ABC" });
    await adapter.send!({ chatId: "456", text: "hello" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ chat_id: "456", text: "hello" });

    vi.unstubAllGlobals();
  });

  it("bot token send throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = resolveSendAdapter({ telegramBotToken: "123:ABC" });
    await expect(adapter.send!({ chatId: "456", text: "hello" })).rejects.toThrow(
      "Telegram API error 403: Forbidden",
    );

    vi.unstubAllGlobals();
  });
});
