import { resolveTelegramAsyncReturnConfig } from "./config.js";
import { createTelegramAsyncReturnService } from "./service.js";
import { getContractHealth, getHookActivity, getClassificationMode } from "./hooks.js";
import { getWorkingMode } from "./working-mode.js";
import { resolveSendAdapter } from "./host-send.js";
import type {
  CommandContextLike,
  CommandResult,
  ContractHealth,
  CreateTelegramAsyncReturnServiceOptions,
  SendMessageFn,
} from "./types.js";

interface AsyncReturnCommandHandlerOptions extends CreateTelegramAsyncReturnServiceOptions {
  sendMessage?: SendMessageFn;
}

export function createAsyncReturnCommandHandler(options: AsyncReturnCommandHandlerOptions) {
  const service = createTelegramAsyncReturnService(options);

  return async function handleAsyncReturnCommand(context: CommandContextLike = {}): Promise<CommandResult> {
    const argv = parseArgs(context.args);
    const command = argv[0] ?? "help";
    const resolvedConfig = resolveTelegramAsyncReturnConfig(options.pluginConfig, options.resolvePath);

    let result: CommandResult;

    switch (command) {
      case "health": {
        const data = await service.health();
        const adapter = resolveSendAdapter({
          sendMessage: options.sendMessage,
          runtime: options.runtime,
          telegramBotToken: resolvedConfig.telegramBotToken,
        });
        const hookActivity = getHookActivity(options.runtime);
        const contractHealth = getContractHealth(options.runtime) ?? {
          inboundNormalization: "unseen",
          agentCompletionCorrelation: "unseen",
          outboundCorrelation: "unseen",
          classification: getClassificationMode(resolvedConfig),
          deliverySignal: "host_send_ack",
          sendAdapter: adapter.kind,
        } satisfies ContractHealth;
        if (!contractHealth.sendAdapter) {
          contractHealth.sendAdapter = adapter.kind;
        }
        const recentTasks = await service.recentTasks({ limit: 5 });
        const latestTask = recentTasks[0];
        const hookSummary = hookActivity
          ? `hooks=[${Object.entries(hookActivity).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}]`
          : "hooks=unknown";
        const contractSummary = `contracts=[inbound:${contractHealth.inboundNormalization},agent:${contractHealth.agentCompletionCorrelation},outbound:${contractHealth.outboundCorrelation},deliverySignal:${contractHealth.deliverySignal}]`;
        const classification = contractHealth.classification ?? getClassificationMode(resolvedConfig);
        const latestSummary = latestTask ? `${latestTask.taskId}:${latestTask.state}` : "none";
        const workingMode = getWorkingMode(options.runtime);
        const wmSummary = workingMode
          ? `wm=[init:${String(workingMode.initialized)},agentEnd:${workingMode.hasAgentEnd},msgSent:${workingMode.hasMessageSent},probeExpired:${String(workingMode.probeExpired)}${workingMode.eventFormat?.chatIdPath ? `,chatIdPath:${workingMode.eventFormat.chatIdPath}` : ""}]`
          : "wm=unknown";
        result = {
          ok: data.ok,
          action: "health",
          message: `enabled=${String(data.enabled)} store=${data.storePath} sendAdapter=${adapter.kind} ${hookSummary} ${contractSummary} classification=${classification} ${wmSummary} recent=${recentTasks.length} latest=${latestSummary}`,
          data: {
            ...data,
            sendAdapter: adapter.kind,
            hookActivity: hookActivity ?? null,
            contractHealth,
            classification,
            workingMode: workingMode ?? null,
            recentTrackedTasks: recentTasks.length,
            latestTask: latestTask ?? null,
          },
        };
        break;
      }

      case "recent": {
        const chatId = getOption(argv, "--chat");
        const limit = getNumberOption(argv, "--limit");
        const lookbackSeconds = getNumberOption(argv, "--lookback");
        const tasks = await service.recentTasks({ chatId, limit, lookbackSeconds });
        result = {
          ok: true,
          action: "recent",
          message: tasks.length
            ? tasks.map((task) => `${task.taskId} ${task.state}`).join("\n")
            : "No recent tasks found.",
          data: tasks,
        };
        break;
      }

      case "status": {
        const taskId = getOption(argv, "--task");
        const chatId = getOption(argv, "--chat");
        const latest = hasFlag(argv, "--latest");
        const lookbackSeconds = getNumberOption(argv, "--lookback");
        const task = await service.getStatus({ taskId, chatId, latest, lookbackSeconds });
        result = task
          ? {
              ok: true,
              action: "status",
              message: `${task.taskId} ${task.state}`,
              data: task,
            }
          : {
              ok: false,
              action: "status",
              message: "No matching task found.",
            };
        break;
      }

      case "resend": {
        const taskId = getRequiredOption(argv, "--task");
        if (!taskId) {
          result = missingArgument("resend", "--task");
          break;
        }

        const task = await service.resendTask(taskId);
        result = task
          ? {
              ok: true,
              action: "resend",
              message: `Queued resend for ${task.taskId}.`,
              data: task,
            }
          : {
              ok: false,
              action: "resend",
              message: "No matching task found.",
            };
        break;
      }

      case "diagnose": {
        const taskId = getOption(argv, "--task");
        const chatId = getOption(argv, "--chat");
        const diagnosis = await service.diagnoseTask({ taskId, chatId, latest: !taskId });
        result = {
          ok: true,
          action: "diagnose",
          message: [diagnosis.recommendedAction, ...diagnosis.notes].join("\n"),
          data: diagnosis,
        };
        break;
      }

      case "repair": {
        const chatId = getRequiredOption(argv, "--chat");
        if (!chatId) {
          result = missingArgument("repair", "--chat");
          break;
        }

        const repair = await service.repairChat(chatId);
        result = {
          ok: true,
          action: "repair",
          message: `repaired=${repair.repairedTaskIds.length} skipped=${repair.skippedTaskIds.length}`,
          data: repair,
        };
        break;
      }

      case "setup": {
        const token = getOption(argv, "--token") ?? (argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined);
        const adapter = resolveSendAdapter({
          sendMessage: options.sendMessage,
          runtime: options.runtime,
          telegramBotToken: resolvedConfig.telegramBotToken,
        });

        if (adapter.kind !== "none") {
          result = {
            ok: true,
            action: "setup",
            message: `Send adapter already configured: ${adapter.kind}\nNo token setup needed.`,
            data: { sendAdapter: adapter.kind, configured: true },
          };
          break;
        }

        if (!token) {
          result = {
            ok: false,
            action: "setup",
            message: buildSetupInstructions(),
            data: { sendAdapter: "none", configured: false },
          };
          break;
        }

        const tokenValid = /^\d+:[A-Za-z0-9_-]{35,}$/.test(token);
        if (!tokenValid) {
          result = {
            ok: false,
            action: "setup",
            message: "Token format is invalid. Expected: <bot_id>:<secret> (e.g., 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw)",
            data: { sendAdapter: "none", configured: false, error: "invalid_token_format" },
          };
          break;
        }

        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
          const body = await res.json() as { ok: boolean; description?: string; result?: { username?: string } };
          if (!res.ok || !body.ok) {
            result = {
              ok: false,
              action: "setup",
              message: `Token rejected by Telegram API: ${body.description ?? String(res.status)}\nCheck that the token is correct and try again.`,
              data: { sendAdapter: "none", configured: false, error: "api_rejected" },
            };
            break;
          }
          const botUsername = body.result?.username ?? "unknown";
          result = {
            ok: true,
            action: "setup",
            message: [
              `Token verified. Bot: @${botUsername}`,
              "",
              "Configure by choosing one of the following:",
              `  Option 1 — Environment variable (recommended):`,
              `    export TELEGRAM_BOT_TOKEN=${token}`,
              `    Then restart the gateway.`,
              `  Option 2 — Plugin config (openclaw.config.json):`,
              `    { "telegramBotToken": "${token}" }`,
              "",
              "After configuring, restart the gateway and run: async-return health",
            ].join("\n"),
            data: { sendAdapter: "config.telegramBotToken", configured: true, botUsername },
          };
        } catch (error) {
          result = {
            ok: false,
            action: "setup",
            message: `Failed to contact Telegram API: ${error instanceof Error ? error.message : String(error)}`,
            data: { sendAdapter: "none", configured: false, error: "network_error" },
          };
        }
        break;
      }

      case "help":
      default: {
        result = {
          ok: command === "help",
          action: "help",
          message: buildHelpText(),
        };
      }
    }

    if (typeof context.reply === "function") {
      await context.reply(result.message);
    }

    return result;
  };
}

function parseArgs(args?: string | string[]) {
  if (Array.isArray(args)) {
    return args;
  }

  if (!args) {
    return [];
  }

  const matches = args.match(/"([^"]*)"|'([^']*)'|(\S+)/g) ?? [];
  return matches.map((item) => item.replace(/^['"]|['"]$/g, ""));
}

function getOption(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function getRequiredOption(argv: string[], name: string) {
  const value = getOption(argv, name);
  return value && !value.startsWith("--") ? value : undefined;
}

function getNumberOption(argv: string[], name: string) {
  const value = getRequiredOption(argv, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasFlag(argv: string[], name: string) {
  return argv.includes(name);
}

function missingArgument(action: string, argument: string): CommandResult {
  return {
    ok: false,
    action,
    message: `Missing required argument ${argument}.`,
  };
}

function buildSetupInstructions() {
  return [
    "No Telegram send adapter is configured (sendAdapter=none).",
    "Tasks will be tracked but results cannot be delivered to Telegram.",
    "",
    "How to fix — choose one option:",
    "  Option 1 — Environment variable (recommended):",
    "    export TELEGRAM_BOT_TOKEN=<your-bot-token>",
    "    Then restart the gateway.",
    "  Option 2 — Plugin config (openclaw.config.json):",
    '    { "telegramBotToken": "<your-bot-token>" }',
    "  Option 3 — Let the host provide api.sendMessage (no token needed).",
    "",
    "To validate a token before configuring:",
    "  async-return setup --token <your-bot-token>",
    "",
    "To get a Telegram bot token, talk to @BotFather on Telegram.",
  ].join("\n");
}

function buildHelpText() {
  return [
    "openclaw-telegram-async-return setup [--token <bot-token>]",
    "openclaw-telegram-async-return health",
    "openclaw-telegram-async-return recent --chat <chat-id> [--limit <n>] [--lookback <seconds>]",
    "openclaw-telegram-async-return status [--task <task-id>] [--chat <chat-id>] [--latest] [--lookback <seconds>]",
    "openclaw-telegram-async-return resend --task <task-id>",
    "openclaw-telegram-async-return diagnose [--task <task-id>] [--chat <chat-id>]",
    "openclaw-telegram-async-return repair --chat <chat-id>",
  ].join("\n");
}
