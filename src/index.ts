import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTelegramAsyncReturnConfigSchema, resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createAsyncReturnCommandHandler } from "./commands.js";
import { resolveSendAdapter } from "./host-send.js";
import {
  handleGatewayStart,
  handleGatewayStop,
  handleMessageReceived,
  handleMessageSent,
  handleAgentEnd,
} from "./hooks.js";

const plugin = {
  id: "telegram-async-return",
  name: "Telegram Async Return",
  description:
    "Reliable async result tracking, resend, and recovery for Telegram tasks that outlive the webhook response window.",
  configSchema: createTelegramAsyncReturnConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.logger?.info?.("[telegram-async-return] registering plugin");

    const pluginConfig = api.pluginConfig ?? {};

    const resolvedConfig = resolveTelegramAsyncReturnConfig(pluginConfig, api.resolvePath);
    if (!api.resolvePath) {
      api.logger?.warn?.(
        `[telegram-async-return] host did not provide resolvePath; storePath resolved via process.cwd(): ${resolvedConfig.storePath}`,
      );
    }
    api.logger?.info?.(`[telegram-async-return] store: ${resolvedConfig.storePath}`);

    const adapter = resolveSendAdapter({
      sendMessage: api.sendMessage,
      runtime: api.runtime,
      telegramBotToken: resolvedConfig.telegramBotToken,
    });
    if (adapter.kind === "none") {
      api.logger?.warn?.(
        `[telegram-async-return] send adapter: none — results will not be delivered to Telegram. ` +
          `Set TELEGRAM_BOT_TOKEN, add telegramBotToken to plugin config, or run: async-return setup`,
      );
    } else {
      api.logger?.info?.(`[telegram-async-return] send adapter: ${adapter.kind}`);
    }

    api.registerService(
      createTelegramAsyncReturnService({
        pluginConfig,
        logger: api.logger,
        runtime: api.runtime,
        resolvePath: api.resolvePath,
      }),
    );

    const commandHandler = createAsyncReturnCommandHandler({
      pluginConfig,
      logger: api.logger,
      runtime: api.runtime,
      sendMessage: api.sendMessage,
      resolvePath: api.resolvePath,
    });

    api.registerCommand({
      name: "async-return",
      description: "Check, resend, diagnose, or repair Telegram async task delivery.",
      acceptsArgs: true,
      handler: (context) => commandHandler(context as Parameters<typeof commandHandler>[0]),
    });

    // Register hooks in both colon and underscore formats for compatibility
    const onGatewayStart = async (event: unknown) => {
      await handleGatewayStart({ api, event, pluginConfig });
    };
    api.on("gateway:startup", onGatewayStart);
    api.on("gateway_start", onGatewayStart);

    const onGatewayStop = async (event: unknown) => {
      await handleGatewayStop({ api, event, pluginConfig });
    };
    api.on("gateway:shutdown", onGatewayStop);
    api.on("gateway_shutdown", onGatewayStop);
    api.on("gateway_stop", onGatewayStop);

    const onMessageReceived = async (event: unknown) => {
      await handleMessageReceived({ api, event, pluginConfig });
    };
    api.on("message:received", onMessageReceived);
    api.on("message_received", onMessageReceived);

    const onMessageSent = async (event: unknown) => {
      await handleMessageSent({ api, event, pluginConfig });
    };
    api.on("message:sent", onMessageSent);
    api.on("message_sent", onMessageSent);

    const onAgentEnd = async (event: unknown) => {
      await handleAgentEnd({ api, event, pluginConfig });
    };
    api.on("agent:end", onAgentEnd);
    api.on("agent_end", onAgentEnd);
  },
};

export default plugin;
