import type { ResolvedSendAdapter, SendMessageFn } from "./types.js";

export function resolveSendAdapter(api: {
  sendMessage?: SendMessageFn;
  runtime?: Record<string | symbol, unknown>;
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

  return { kind: "none" };
}
