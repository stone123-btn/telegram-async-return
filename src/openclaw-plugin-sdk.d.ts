declare module "openclaw/plugin-sdk" {
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
    registerService(service: unknown): void;
    registerCommand(command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      handler: (context: unknown) => unknown | Promise<unknown>;
    }): void;
    on(event: string, handler: (event: unknown) => unknown | Promise<unknown>): void;
  }
}
