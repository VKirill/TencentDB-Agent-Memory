import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runInit } from "./init.js";

/**
 * Test plan (SPEC §5 Task 13):
 *  1. Fresh init creates .claude/memory/{config.json, .gitignore}
 *  2. Idempotent: second run without --force is a no-op (does NOT overwrite)
 *  3. --force overwrites config.json with template
 *  4. Bad target (e.g. non-writable / non-existent parent) → exit 0 + error
 *     recorded in result (CLI wraps into process.exit(0) per hook discipline)
 */

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-init-"));
  tmpDirs.push(root);
  return root;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("runInit", () => {
  it("creates .claude/memory/ with config.json and .gitignore on fresh run", async () => {
    const projectRoot = makeTmpProject();

    const result = await runInit({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);

    const memDir = path.join(projectRoot, ".claude", "memory");
    expect(fs.existsSync(memDir)).toBe(true);
    expect(fs.existsSync(path.join(memDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, ".gitignore"))).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(path.join(memDir, "config.json"), "utf-8"));
    // Sanity: it loaded the default template
    expect(cfg.embedding.provider).toBe("openai");
    expect(cfg.llm.model).toBe("deepseek/deepseek-v4-flash");

    // .gitignore must hide the whole memory dir from the project's git
    const gi = fs.readFileSync(path.join(memDir, ".gitignore"), "utf-8");
    expect(gi.trim()).toBe("*");
  });

  it("is idempotent: second run without --force does not overwrite", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });

    // Mutate config to detect overwrite
    const cfgPath = path.join(projectRoot, ".claude", "memory", "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ marker: "user-customized" }));

    const result = await runInit({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    // User's custom config preserved
    const after = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(after.marker).toBe("user-customized");
  });

  it("--force overwrites existing config.json with template", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });

    const cfgPath = path.join(projectRoot, ".claude", "memory", "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ marker: "user-customized" }));

    const result = await runInit({ projectRoot, force: true });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    const after = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(after.marker).toBeUndefined();
    expect(after.embedding.provider).toBe("openai");
  });

  it("silent:true suppresses result.message (used by auto-init from hooks)", async () => {
    const projectRoot = makeTmpProject();

    const result = await runInit({ projectRoot, silent: true });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    // Hooks must not pollute stdout — silent mode omits message
    expect(result.message).toBeUndefined();

    // But layout still created
    expect(fs.existsSync(path.join(projectRoot, ".claude", "memory", "config.json"))).toBe(true);
  });

  it("returns ok=true with error string when target cannot be created (hook discipline)", async () => {
    // Point at a path under a non-existent parent inside an unwritable location
    // (we use a file path treated as a dir — open() will fail under it).
    const nonExistent = path.join(makeTmpProject(), "file-not-a-dir");
    fs.writeFileSync(nonExistent, "this is a file, not a dir");

    const result = await runInit({ projectRoot: nonExistent });

    // CLI wrapper exits 0 regardless; runInit reports ok=false but doesn't throw
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
