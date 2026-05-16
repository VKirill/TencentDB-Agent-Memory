import { describe, expect, it } from "vitest";

/**
 * Smoke test — ensures vitest scaffolding works.
 * Discovered by vitest.config.ts include glob `src/**\/*.test.ts`.
 * Real tests live alongside their source files (`src/cli/commands/init.test.ts` etc.).
 */
describe("vitest scaffolding sanity", () => {
  it("loads and executes a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("supports async assertions", async () => {
    const value = await Promise.resolve(42);
    expect(value).toBe(42);
  });
});
