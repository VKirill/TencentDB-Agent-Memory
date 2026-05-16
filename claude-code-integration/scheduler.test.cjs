// scheduler.test.cjs — node --test (built-in test runner, Node 22+)
// Tests pure functions only. Spawning subprocess + ticker tested via
// manual E2E (SPEC Task A3) — not unit-testable in-process.
//
// Run: node --test claude-code-integration/scheduler.test.cjs

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { parseAllowlist, acquireLock, releaseLock } = require("./scheduler.cjs");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-mem-sched-"));
}

test("parseAllowlist: strips comments + blank lines + non-absolute paths", () => {
  const tmp = makeTmpDir();
  const file = path.join(tmp, "allowlist.txt");
  fs.writeFileSync(
    file,
    [
      "# this is a comment",
      "",
      "/abs/path/one",
      "  /abs/path/two  ",
      "relative/path/should-be-skipped",
      "# /abs/commented/out",
      "/abs/path/three",
      "",
    ].join("\n"),
  );

  const result = parseAllowlist(file);
  assert.deepEqual(result, ["/abs/path/one", "/abs/path/two", "/abs/path/three"]);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseAllowlist: missing file → empty array", () => {
  assert.deepEqual(parseAllowlist("/no/such/file.txt"), []);
});

test("acquireLock: fresh project → returns true, writes PID + ts", () => {
  const project = makeTmpDir();
  fs.mkdirSync(path.join(project, ".claude", "memory"), { recursive: true });

  const lockPath = path.join(project, ".claude", "memory", ".extract.lock");
  assert.equal(acquireLock(project), true);
  assert.ok(fs.existsSync(lockPath));

  const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  assert.equal(typeof content.pid, "number");
  assert.equal(typeof content.ts, "string");
  assert.match(content.ts, /^\d{4}-\d{2}-\d{2}T/);

  fs.rmSync(project, { recursive: true, force: true });
});

test("acquireLock: existing fresh lock (alive pid) → returns false", () => {
  const project = makeTmpDir();
  fs.mkdirSync(path.join(project, ".claude", "memory"), { recursive: true });

  const lockPath = path.join(project, ".claude", "memory", ".extract.lock");
  // Write a lock claiming the current process — definitely alive.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
  );

  assert.equal(acquireLock(project), false);

  fs.rmSync(project, { recursive: true, force: true });
});

test("acquireLock: stale lock (dead pid + old) → reclaim → returns true", () => {
  const project = makeTmpDir();
  fs.mkdirSync(path.join(project, ".claude", "memory"), { recursive: true });

  const lockPath = path.join(project, ".claude", "memory", ".extract.lock");
  // PID 1 is init/systemd — exists on Linux. Use 0x7fff_ffff (max int32)
  // as a dead-pid candidate; extremely unlikely to be a real process.
  const deadPid = 0x7fffffff;
  const oldTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: oldTs }));

  assert.equal(acquireLock(project), true);
  // Lock now belongs to current process
  const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  assert.equal(content.pid, process.pid);

  fs.rmSync(project, { recursive: true, force: true });
});

test("releaseLock: removes file; idempotent on missing", () => {
  const project = makeTmpDir();
  fs.mkdirSync(path.join(project, ".claude", "memory"), { recursive: true });
  acquireLock(project);
  releaseLock(project);
  const lockPath = path.join(project, ".claude", "memory", ".extract.lock");
  assert.equal(fs.existsSync(lockPath), false);

  // Second release is no-op (no throw)
  assert.doesNotThrow(() => releaseLock(project));

  fs.rmSync(project, { recursive: true, force: true });
});
