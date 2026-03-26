import type { ResolvedSendAdapter, SendMessageFn } from "./types.js";

export function resolveSendAdapter(api: {
  sendMessage?: SendMessageFn;
  runtime?: Record<string | symbol, unknown>;
  telegramBotToken?: string;
}): ResolvedSendAdapter {
  if (typeof api.sendMessage === "function") {
    return {
      kind: "api.sendMessage",
      send: api.sendMessage,
    };
  }

  const runtime = api.runtime as Record<string, unknown> | undefined;
  const telegram = runtime?.telegram as Record<string, unknown> | undefined;
  const sendMessageTelegram = telegram?.sendMessageTelegram;

  if (typeof sendMessageTelegram === "function") {
    return {
      kind: "runtime.telegram.sendMessageTelegram",
      send: async ({ chatId, text, metadata }) => {
        if (!chatId) {
          throw new Error("chatId is required for Telegram delivery");
        }
        await (sendMessageTelegram as (...args: unknown[]) => Promise<unknown>)(
          chatId,
          text,
          metadata,
        );
      },
    };
  }

  const token = api.telegramBotToken;
  if (token) {
    const send: SendMessageFn = async ({ chatId, text }) => {
      if (!chatId) throw new Error("chatId is required for Telegram delivery");
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram API error ${res.status}: ${body}`);
      }
    };
    return { kind: "config.telegramBotToken", send };
  }

  return { kind: "none" };
}
