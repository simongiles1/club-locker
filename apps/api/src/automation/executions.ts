import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { executionSteps, executions } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { captureLangfuseTrace } from "./langfuseClient.js";

export type ExecutionTrigger = {
  kind: "imap" | "cron" | "manual" | "replay" | "retry" | "system";
  refId?: string;
};

export type StepRuntimeMode = "normal" | "replay" | "retry";

export interface ExecutionContext {
  executionId: string;
  mode: StepRuntimeMode;
  step<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T>;
  aiStep<T extends { completion: string; model: string; prompt: string }>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
  ): Promise<T>;
}

type RunOptions = {
  parentExecutionId?: string | null;
  mode?: StepRuntimeMode;
};

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function maybeParse(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

export async function runWithExecution<T>(
  db: Db,
  config: AppConfig,
  workflow: string,
  trigger: ExecutionTrigger,
  input: unknown,
  fn: (ctx: ExecutionContext) => Promise<T>,
  opts: RunOptions = {},
): Promise<T> {
  const started = Date.now();
  const executionId = crypto.randomUUID();
  db.insert(executions)
    .values({
      id: executionId,
      workflow,
      triggerKind: trigger.kind,
      triggerRefId: trigger.refId ?? null,
      status: "running",
      inputJson: serialize(input),
      startedAt: new Date(started).toISOString(),
      parentExecutionId: opts.parentExecutionId ?? null,
    })
    .run();

  let stepOrder = 0;
  const mode = opts.mode ?? "normal";
  const context: ExecutionContext = {
    executionId,
    mode,
    async step<U>(name: string, stepInput: unknown, stepFn: () => Promise<U>) {
      const stepId = crypto.randomUUID();
      const startedAt = Date.now();
      const order = stepOrder++;
      db.insert(executionSteps)
        .values({
          id: stepId,
          executionId,
          name,
          stepOrder: order,
          status: "running",
          inputJson: serialize(stepInput),
        })
        .run();
      try {
        const output = await stepFn();
        db.update(executionSteps)
          .set({
            status: "ok",
            outputJson: serialize(output),
            durationMs: Date.now() - startedAt,
          })
          .where(eq(executionSteps.id, stepId))
          .run();
        return output;
      } catch (err) {
        db.update(executionSteps)
          .set({
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          })
          .where(eq(executionSteps.id, stepId))
          .run();
        throw err;
      }
    },
    async aiStep<U extends { completion: string; model: string; prompt: string }>(
      name: string,
      stepInput: unknown,
      stepFn: () => Promise<U>,
    ) {
      const stepId = crypto.randomUUID();
      const startedAt = Date.now();
      const order = stepOrder++;
      db.insert(executionSteps)
        .values({
          id: stepId,
          executionId,
          name,
          stepOrder: order,
          status: "running",
          inputJson: serialize(stepInput),
        })
        .run();
      try {
        const output = await stepFn();
        const traceId = await captureLangfuseTrace(config, {
          name,
          model: output.model,
          prompt: output.prompt,
          completion: output.completion,
          metadata: {
            executionId,
            stepName: name,
          },
        });
        db.update(executionSteps)
          .set({
            status: "ok",
            outputJson: serialize(output),
            durationMs: Date.now() - startedAt,
            langfuseTraceId: traceId,
          })
          .where(eq(executionSteps.id, stepId))
          .run();
        return output;
      } catch (err) {
        db.update(executionSteps)
          .set({
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          })
          .where(eq(executionSteps.id, stepId))
          .run();
        throw err;
      }
    },
  };

  try {
    const output = await fn(context);
    db.update(executions)
      .set({
        status: "ok",
        outputJson: serialize(output),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      })
      .where(eq(executions.id, executionId))
      .run();
    return output;
  } catch (err) {
    db.update(executions)
      .set({
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? (err.stack ?? null) : null,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      })
      .where(eq(executions.id, executionId))
      .run();
    throw err;
  }
}

export type ExecutionFilters = {
  workflow?: string;
  status?: "running" | "ok" | "error";
  sinceIso?: string;
  limit?: number;
};

export function listExecutions(db: Db, filters: ExecutionFilters) {
  const clauses = [];
  if (filters.workflow) clauses.push(eq(executions.workflow, filters.workflow));
  if (filters.status) clauses.push(eq(executions.status, filters.status));
  if (filters.sinceIso) clauses.push(gte(executions.createdAt, filters.sinceIso));
  const whereClause =
    clauses.length === 0
      ? undefined
      : clauses.length === 1
        ? clauses[0]
        : and(...clauses);
  return db
    .select()
    .from(executions)
    .where(whereClause)
    .orderBy(desc(executions.createdAt))
    .limit(Math.min(Math.max(filters.limit ?? 50, 1), 200))
    .all()
    .map((row) => ({
      ...row,
      input: maybeParse(row.inputJson),
      output: maybeParse(row.outputJson),
    }));
}

export function getExecutionDetail(db: Db, executionId: string) {
  const execution = db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .get();
  if (!execution) return null;
  const steps = db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.executionId, executionId))
    .orderBy(sql`${executionSteps.stepOrder} asc`)
    .all()
    .map((step) => ({
      ...step,
      input: maybeParse(step.inputJson),
      output: maybeParse(step.outputJson),
    }));
  return {
    ...execution,
    input: maybeParse(execution.inputJson),
    output: maybeParse(execution.outputJson),
    steps,
  };
}
