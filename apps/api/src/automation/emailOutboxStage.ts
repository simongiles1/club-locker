import { eq } from "drizzle-orm";
import type { EmailAdapter } from "../adapters/email.js";
import type { Db } from "../db/client.js";
import { emailOutbox } from "../db/schema.js";

export async function stageAndMaybeSend(
  db: Db,
  emailAdapter: EmailAdapter,
  autoSend: boolean,
  email: {
    kind: string;
    seasonId?: string | null;
    toAddress: string;
    subject: string;
    body: string;
    meta: Record<string, unknown>;
  },
): Promise<{ outboxId: string; sent: boolean }> {
  const outboxId = crypto.randomUUID();
  db.insert(emailOutbox)
    .values({
      id: outboxId,
      kind: email.kind,
      seasonId: email.seasonId ?? null,
      status: autoSend ? "approved" : "draft",
      scheduledSendAt: null,
      toAddress: email.toAddress,
      subject: email.subject,
      body: email.body,
      metaJson: JSON.stringify(email.meta),
    })
    .run();
  if (!autoSend) return { outboxId, sent: false };
  const sendRes = await emailAdapter.send({
    to: email.toAddress,
    subject: email.subject,
    body: email.body,
    meta: email.meta,
  });
  if (!sendRes.ok) return { outboxId, sent: false };
  const ts = new Date().toISOString();
  db.update(emailOutbox)
    .set({ status: "sent", sentAt: ts })
    .where(eq(emailOutbox.id, outboxId))
    .run();
  return { outboxId, sent: true };
}
