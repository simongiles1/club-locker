import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { championships, championshipEntries, inboundActions, inboundEmails, players } from "../db/schema.js";
import { approveInboundAction } from "./applyAction.js";
import { seedAutomationSettings } from "./settings.js";

function testDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `automation-apply-${crypto.randomUUID()}.sqlite`,
  ).replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("approveInboundAction", () => {
  it("applies signup actions into championship entries", async () => {
    const db = testDb();
    seedAutomationSettings(db);
    const playerId = crypto.randomUUID();
    const championshipId = crypto.randomUUID();
    const emailId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    db.insert(players)
      .values({
        id: playerId,
        displayName: "Alice",
        email: "unit+alice@example.test",
        rating: "4.0",
      })
      .run();
    db.insert(championships)
      .values({
        id: championshipId,
        seasonId: null,
        format: "singles",
        divisionKind: "skill",
        divisionLabel: "A",
        name: "Singles A",
        status: "registration",
      })
      .run();
    db.insert(inboundEmails)
      .values({
        id: emailId,
        messageId: "msg-1",
        fromAddress: "unit+alice@example.test",
        toAddress: "cambridgeclubchamps@gmail.com",
        subject: "Sign me up",
        bodyText: "Please enter me",
        bodyHtml: null,
        aliasTag: "alice",
        receivedAt: new Date().toISOString(),
      })
      .run();
    db.insert(inboundActions)
      .values({
        id: actionId,
        emailId,
        kind: "signup",
        payloadJson: JSON.stringify({ championshipId }),
        confidence: "high",
        status: "pending",
      })
      .run();

    const config = loadConfig();
    const emailAdapter = { send: async () => ({ ok: true as const }) };
    const result = await approveInboundAction(
      db,
      config,
      emailAdapter,
      actionId,
    );
    expect(result.ok).toBe(true);
    const entry = db
      .select()
      .from(championshipEntries)
      .where(
        and(
          eq(championshipEntries.championshipId, championshipId),
          eq(championshipEntries.playerId, playerId),
        ),
      )
      .get();
    expect(entry).toBeTruthy();
    const updatedAction = db
      .select()
      .from(inboundActions)
      .where(eq(inboundActions.id, actionId))
      .get();
    expect(updatedAction?.status).toBe("applied");
  });
});
