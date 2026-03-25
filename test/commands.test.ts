import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createAsyncReturnCommandHandler } from "../src/commands.js";

function tmpDir() {
  const dir = join(tmpdir(), `tar-cmd-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeHandler(dir: string) {
  return createAsyncReturnCommandHandler({
    pluginConfig: { storePath: join(dir, "store.db") },
    logger: {},
    runtime: {},
    resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
  });
}

describe("commands", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("health returns ok", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["health"] });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("health");
    expect(result.message).toContain("enabled=true");
  });

  it("recent with no tasks returns message", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["recent", "--chat", "c1"] });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("No recent tasks found.");
  });

  it("status with no tasks returns not ok", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["status", "--chat", "c1", "--latest"] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No matching task found.");
  });

  it("resend without --task returns missing argument", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["resend"] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing required argument");
  });

  it("repair without --chat returns missing argument", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["repair"] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing required argument");
  });

  it("help returns usage text", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["help"] });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("help");
    expect(result.message).toContain("health");
    expect(result.message).toContain("resend");
  });

  it("diagnose with no tasks returns inspect_runtime", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: ["diagnose", "--chat", "c1"] });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("diagnose");
    expect(result.message).toContain("inspect_runtime");
  });

  it("parses string args correctly", async () => {
    const handler = makeHandler(dir);
    const result = await handler({ args: "health" });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("health");
  });

  it("calls reply if provided", async () => {
    const handler = makeHandler(dir);
    let replied = "";
    await handler({
      args: ["health"],
      reply: (msg: string) => { replied = msg; },
    });
    expect(replied).toContain("enabled=true");
  });
});
