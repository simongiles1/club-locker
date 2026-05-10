import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import type { EmailAdapter } from "../adapters/email.js";
import type { AiAgent } from "./aiAgent.js";
import { approveInboundAction, rejectInboundAction } from "./applyAction.js";
import { advanceClockMs, readClockState, setClockIso } from "./clock.js";
import { getExecutionDetail, listExecutions } from "./executions.js";
import { processInboundEmail } from "./inbound.js";
import type { ImapAutomationPoller } from "./imapPoller.js";
import { runSchedulerTick } from "./scheduler.js";
import { getSetting, isSettingOn, seedAutomationSettings, setSetting } from "./settings.js";
import { inboundActions, inboundEmails } from "../db/schema.js";

type Dependencies = {
  db: Db;
  config: AppConfig;
  emailAdapter: EmailAdapter;
  aiAgent: AiAgent;
  poller: ImapAutomationPoller | null;
};

const injectEmailBody = z.object({
  messageId: z.string().min(1).optional(),
  fromAddress: z.string().email(),
  toAddress: z.string().email(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  receivedAt: z.string().optional(),
});

export function registerAutomationRoutes(
  app: FastifyInstance,
  deps: Dependencies,
): void {
  const { db, config, emailAdapter, aiAgent, poller } = deps;
  seedAutomationSettings(db);

  app.get("/api/automation/settings", async () => ({
    testMode: getSetting(db, "automation.test_mode", "off"),
    autoSendTest: getSetting(db, "automation.auto_send_test", "off"),
    autoSendProd: getSetting(db, "automation.auto_send_prod", "off"),
    imapPaused: getSetting(db, "automation.imap_paused", "off"),
    schedulerPaused: getSetting(db, "automation.scheduler_paused", "off"),
    autoApplyConfidenceMin: getSetting(
      db,
      "automation.auto_apply_confidence_min",
      "medium",
    ),
  }));

  app.post("/api/automation/settings", async (req) => {
    const body = z
      .object({
        testMode: z.enum(["on", "off"]).optional(),
        autoSendTest: z.enum(["on", "off"]).optional(),
        autoSendProd: z.enum(["on", "off"]).optional(),
        imapPaused: z.enum(["on", "off"]).optional(),
        schedulerPaused: z.enum(["on", "off"]).optional(),
        autoApplyConfidenceMin: z.enum(["low", "medium", "high"]).optional(),
      })
      .parse(req.body ?? {});
    if (body.testMode) setSetting(db, "automation.test_mode", body.testMode);
    if (body.autoSendTest)
      setSetting(db, "automation.auto_send_test", body.autoSendTest);
    if (body.autoSendProd)
      setSetting(db, "automation.auto_send_prod", body.autoSendProd);
    if (body.imapPaused) setSetting(db, "automation.imap_paused", body.imapPaused);
    if (body.schedulerPaused)
      setSetting(db, "automation.scheduler_paused", body.schedulerPaused);
    if (body.autoApplyConfidenceMin) {
      setSetting(
        db,
        "automation.auto_apply_confidence_min",
        body.autoApplyConfidenceMin,
      );
    }
    return { ok: true };
  });

  app.get("/api/automation/clock", async () => readClockState(db));

  app.post("/api/automation/clock", async (req, reply) => {
    const body = z
      .object({
        setIso: z.string().optional(),
        advanceMs: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    try {
      if (body.setIso) return setClockIso(db, body.setIso);
      if (body.advanceMs != null) return advanceClockMs(db, body.advanceMs);
      return readClockState(db);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/automation/inbox", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query ?? {});
    const emails = db
      .select()
      .from(inboundEmails)
      .orderBy(desc(inboundEmails.createdAt))
      .limit(q.limit ?? 100)
      .all();
    return emails.map((email) => {
      const action = db
        .select()
        .from(inboundActions)
        .where(eq(inboundActions.emailId, email.id))
        .all()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      return { email, action };
    });
  });

  app.post("/api/automation/actions/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await approveInboundAction(db, config, emailAdapter, id);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/automation/actions/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ reason: z.string().optional() })
      .parse(req.body ?? {});
    return rejectInboundAction(db, id, body.reason);
  });

  app.post("/api/automation/scheduler/tick", async (req, reply) => {
    if (isSettingOn(db, "automation.scheduler_paused")) {
      return reply.code(409).send({ error: "scheduler_paused" });
    }
    try {
      return await runSchedulerTick(db, config, emailAdapter, { kind: "manual" });
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/automation/test/inject-email", async (req, reply) => {
    if (getSetting(db, "automation.test_mode", "off") !== "on") {
      return reply.code(409).send({ error: "test_mode_required" });
    }
    const body = injectEmailBody.parse(req.body);
    try {
      return await processInboundEmail(
        db,
        config,
        aiAgent,
        {
          messageId:
            body.messageId ?? `inject-${Date.now()}-${crypto.randomUUID()}`,
          fromAddress: body.fromAddress,
          toAddress: body.toAddress,
          subject: body.subject,
          bodyText: body.bodyText,
          bodyHtml: body.bodyHtml,
          receivedAt: body.receivedAt,
        },
        { kind: "manual", refId: body.messageId },
        "normal",
        async (actionId) => {
          await approveInboundAction(db, config, emailAdapter, actionId);
        },
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/automation/imap/poll", async (req, reply) => {
    if (!poller) return reply.code(501).send({ error: "poller_not_initialized" });
    if (isSettingOn(db, "automation.imap_paused")) {
      return reply.code(409).send({ error: "imap_paused" });
    }
    return await poller.pollOnce("manual");
  });

  app.get("/api/automation/executions", async (req) => {
    const q = z
      .object({
        workflow: z.string().optional(),
        status: z.enum(["running", "ok", "error"]).optional(),
        since: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query ?? {});
    return listExecutions(db, {
      workflow: q.workflow,
      status: q.status,
      sinceIso: q.since,
      limit: q.limit,
    });
  });

  app.get("/api/automation/executions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = getExecutionDetail(db, id);
    if (!detail) return reply.code(404).send({ error: "execution_not_found" });
    return detail;
  });

  app.post("/api/automation/executions/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = getExecutionDetail(db, id);
    if (!detail) return reply.code(404).send({ error: "execution_not_found" });
    try {
      return await replayExecutionByWorkflow(
        db,
        config,
        emailAdapter,
        aiAgent,
        detail.workflow,
        detail.input,
        id,
        "replay",
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/automation/executions/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = getExecutionDetail(db, id);
    if (!detail) return reply.code(404).send({ error: "execution_not_found" });
    try {
      return await replayExecutionByWorkflow(
        db,
        config,
        emailAdapter,
        aiAgent,
        detail.workflow,
        detail.input,
        id,
        "retry",
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function replayExecutionByWorkflow(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  aiAgent: AiAgent,
  workflow: string,
  input: unknown,
  parentExecutionId: string,
  mode: "replay" | "retry",
): Promise<unknown> {
  if (workflow === "inbound_email_processing") {
    const payload = injectEmailBody.extend({ messageId: z.string() }).parse(input);
    return processInboundEmail(
      db,
      config,
      aiAgent,
      payload,
      { kind: mode, refId: parentExecutionId },
      mode,
    );
  }
  if (workflow === "apply_action") {
    const payload = z.object({ actionId: z.string() }).parse(input);
    return approveInboundAction(
      db,
      config,
      emailAdapter,
      payload.actionId,
      mode,
    );
  }
  if (workflow === "scheduler_tick") {
    return runSchedulerTick(
      db,
      config,
      emailAdapter,
      { kind: mode, refId: parentExecutionId },
      mode,
    );
  }
  throw new Error(`replay_not_supported_for_workflow:${workflow}`);
}
