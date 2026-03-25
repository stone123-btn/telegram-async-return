import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTelegramAsyncReturnConfigSchema } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { createAsyncReturnCommandHandler } from "./commands.js";
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
    });

    api.registerCommand({
      name: "async-return",
      description: "Check, resend, diagnose, or repair Telegram async task delivery.",
      acceptsArgs: true,
      handler: (context) => commandHandler(context as Parameters<typeof commandHandler>[0]),
    });

    api.on("gateway_start", async (event) => {
      await handleGatewayStart({
        api,
        event,
        pluginConfig,
      });
    });

    api.on("gateway_stop", async (event) => {
      await handleGatewayStop({
        api,
        event,
        pluginConfig,
      });
    });

    api.on("message_received", async (event) => {
      await handleMessageReceived({
        api,
        event,
        pluginConfig,
      });
    });

    api.on("message_sent", async (event) => {
      await handleMessageSent({
        api,
        event,
        pluginConfig,
      });
    });

    api.on("agent_end", async (event) => {
      await handleAgentEnd({
        api,
        event,
        pluginConfig,
      });
    });
  },
};

export default plugin;
