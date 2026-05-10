import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { inboundActions, inboundEmails } from "../db/schema.js";
import { createAiAgent } from "./aiAgent.js";
import { processInboundEmail } from "./inbound.js";
import { seedAutomationSettings } from "./settings.js";

function testDb() {
  const dbPath = path
    .join(os.tmpdir(), `inbound-${crypto.randomUUID()}.sqlite`)
    .replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("processInboundEmail", () => {
  it("resumes when inbound_emails exists without inbound_actions (no UNIQUE error)", async () => {
    const db = testDb();
    seedAutomationSettings(db);
    const config = { ...loadConfig(), AI_AGENT: "mock" as const };
    const aiAgent = createAiAgent(config);
    const messageId = "<partial-abc@mail.gmail.com>";
    const emailId = crypto.randomUUID();
    db.insert(inboundEmails)
      .values({
        id: emailId,
        messageId,
        fromAddress: "sender@example.test",
        toAddress: "cambridgeclubchamps@gmail.com",
        subject: "Retry me",
        bodyText: "Please sign me up for the draw",
        bodyHtml: null,
        aliasTag: null,
        receivedAt: new Date().toISOString(),
      })
      .run();

    const result = await processInboundEmail(db, config, aiAgent, {
      messageId,
      fromAddress: "sender@example.test",
      toAddress: "cambridgeclubchamps@gmail.com",
      subject: "Retry me",
      bodyText: "Please sign me up for the draw",
    });

    expect(result.emailId).toBe(emailId);
    const action = db
      .select()
      .from(inboundActions)
      .where(eq(inboundActions.emailId, emailId))
      .get();
    expect(action).toBeTruthy();
    expect(action?.kind).toBe("signup");

    const row = db.select().from(inboundEmails).where(eq(inboundEmails.id, emailId)).get();
    expect(row?.processedAt).toBeTruthy();
  });
});
