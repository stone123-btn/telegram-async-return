#!/usr/bin/env node

import { createAsyncReturnCommandHandler } from "./commands.js";

const handler = createAsyncReturnCommandHandler({
  pluginConfig: {},
  runtime: {},
  logger: {
    info: (message) => process.stderr.write(`${String(message)}\n`),
    warn: (message) => process.stderr.write(`${String(message)}\n`),
    error: (message) => process.stderr.write(`${String(message)}\n`),
    debug: () => undefined,
  },
  resolvePath: (input) => (input.startsWith("/") ? input : `${process.cwd()}/${input}`),
});

const result = await handler({
  args: process.argv.slice(2),
  reply: (message) => {
    process.stdout.write(`${message}\n`);
  },
});

if (!result.ok) {
  process.exitCode = 1;
}
