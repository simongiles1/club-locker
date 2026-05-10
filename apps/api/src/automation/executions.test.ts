import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { executionSteps, executions } from "../db/schema.js";
import { runWithExecution } from "./executions.js";

function testDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `automation-exec-${crypto.randomUUID()}.sqlite`,
  );
  const normalized = dbPath.replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${normalized}`);
}

describe("runWithExecution", () => {
  it("captures step input/output on success", async () => {
    const db = testDb();
    const config = loadConfig();
    const result = await runWithExecution(
      db,
      config,
      "unit_success",
      { kind: "manual", refId: "abc" },
      { foo: "bar" },
      async (ctx) => {
        const value = await ctx.step("compute", { a: 2 }, async () => 3);
        return { value };
      },
    );
    expect(result).toEqual({ value: 3 });
    const run = db
      .select()
      .from(executions)
      .where(eq(executions.workflow, "unit_success"))
      .get();
    expect(run?.status).toBe("ok");
    const steps = db.select().from(executionSteps).where(eq(executionSteps.executionId, run!.id)).all();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("compute");
    expect(steps[0].status).toBe("ok");
  });

  it("captures failure details", async () => {
    const db = testDb();
    const config = loadConfig();
    await expect(
      runWithExecution(
        db,
        config,
        "unit_error",
        { kind: "manual" },
        {},
        async (ctx) => {
          await ctx.step("explode", {}, async () => {
            throw new Error("boom");
          });
          return { ok: true };
        },
      ),
    ).rejects.toThrow("boom");
    const run = db
      .select()
      .from(executions)
      .where(eq(executions.workflow, "unit_error"))
      .get();
    expect(run?.status).toBe("error");
    expect(run?.errorMessage).toContain("boom");
  });
});
