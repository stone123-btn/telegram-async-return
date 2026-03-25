declare module "openclaw/plugin-sdk" {
  export interface OpenClawEvent {
    type: string;
    action: string;
    sessionKey?: string;
    context?: Record<string, unknown>;
  }

  export interface OpenClawPluginApi {
    logger?: {
      info?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
      error?: (...args: unknown[]) => void;
      debug?: (...args: unknown[]) => void;
    };
    runtime?: Record<string | symbol, unknown>;
    pluginConfig?: Record<string, unknown>;
    resolvePath?: (input: string) => string;
    sendMessage?: (msg: {
      chatId?: string;
      text: string;
      metadata?: Record<string, unknown>;
    }) => Promise<void>;
    registerService(service: unknown): void;
    registerCommand(command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      handler: (context: unknown) => unknown | Promise<unknown>;
    }): void;
    on<E extends OpenClawEvent = OpenClawEvent>(
      event: string,
      handler: (event: E) => void | Promise<void>,
    ): void;
  }
}

declare module "openclaw/hooks" {
  import type { OpenClawEvent } from "openclaw/plugin-sdk";
  export type HookHandler<E extends OpenClawEvent = OpenClawEvent> = (
    event: E,
  ) => void | Promise<void>;
}
