import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { EmailAdapter } from "../adapters/email.js";
import type { Db } from "../db/client.js";
import { emailOutbox } from "../db/schema.js";

/**
 * Delivers outbox rows queued with `status=scheduled` once `scheduled_send_at` is reached.
 * Runs on the main automation tick regardless of draft/approve behaviour for other mail.
 */
export async function processScheduledOutbox(
  db: Db,
  emailAdapter: EmailAdapter,
  now: Date,
): Promise<{ dispatched: number; sent: number; failed: number }> {
  const nowIso = now.toISOString();
  const rows = db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, "scheduled"),
        isNotNull(emailOutbox.scheduledSendAt),
        lte(emailOutbox.scheduledSendAt, nowIso),
      ),
    )
    .all();

  let dispatched = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    dispatched += 1;
    let meta: Record<string, unknown> = {};
    if (row.metaJson) {
      try {
        meta = JSON.parse(row.metaJson) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    const sendRes = await emailAdapter.send({
      to: row.toAddress,
      subject: row.subject,
      body: row.body,
      meta: { ...meta, outboxId: row.id, kind: row.kind },
    });
    if (sendRes.ok) {
      sent += 1;
      const ts = new Date().toISOString();
      db.update(emailOutbox)
        .set({ status: "sent", sentAt: ts })
        .where(eq(emailOutbox.id, row.id))
        .run();
    } else {
      failed += 1;
      db.update(emailOutbox)
        .set({ status: "error" })
        .where(eq(emailOutbox.id, row.id))
        .run();
    }
  }

  return { dispatched, sent, failed };
}
