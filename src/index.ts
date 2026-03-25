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
import type {
  GatewayStartupEvent,
  GatewayShutdownEvent,
  MessageReceivedEvent,
  MessageSentEvent,
  AgentEndEvent,
} from "./types.js";

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

    api.on("gateway:startup", async (event) => {
      await handleGatewayStart({ api, event: event as GatewayStartupEvent, pluginConfig });
    });

    api.on("gateway:shutdown", async (event) => {
      await handleGatewayStop({ api, event: event as GatewayShutdownEvent, pluginConfig });
    });

    api.on("message:received", async (event) => {
      await handleMessageReceived({ api, event: event as MessageReceivedEvent, pluginConfig });
    });

    api.on("message:sent", async (event) => {
      await handleMessageSent({ api, event: event as MessageSentEvent, pluginConfig });
    });

    api.on("agent:end", async (event) => {
      await handleAgentEnd({ api, event: event as AgentEndEvent, pluginConfig });
    });
  },
};

export default plugin;
