import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CHAMPIONSHIP_DIVISION_KINDS,
  listAllChampionshipDivisions,
} from "@squash/shared";
import type { Db } from "../db/client.js";
import {
  addEntry,
  createChampionship,
  deleteChampionship,
  generateDraw,
  getChampionshipDetail,
  listChampionships,
  publishDraw,
  removeEntry,
  stageRoundOneMatchEmails,
  updateEntry,
  updateMatch,
} from "./service.js";

const divisionBody = z.object({
  format: z.enum(["singles", "doubles"]),
  kind: z.enum(CHAMPIONSHIP_DIVISION_KINDS),
  label: z.string().min(1),
});

const createBody = z.object({
  seasonId: z.string().optional(),
  division: divisionBody,
  name: z.string().optional(),
  roundOneDueDate: z.string().optional(),
});

const entryBody = z.object({
  playerId: z.string(),
  partnerPlayerId: z.string().optional(),
  seed: z.number().int().min(1).optional(),
});

const entryPatch = z.object({
  seed: z.number().int().min(1).nullable().optional(),
  partnerPlayerId: z.string().nullable().optional(),
});

const matchPatch = z.object({
  topEntryId: z.string().nullable().optional(),
  bottomEntryId: z.string().nullable().optional(),
  winnerEntryId: z.string().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
});

const stageEmailsBody = z.object({
  round: z.number().int().min(1).optional(),
});

export function registerChampionshipRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/championships/divisions", async () =>
    listAllChampionshipDivisions(),
  );

  app.get("/api/championships", async (req) => {
    const q = z
      .object({
        seasonId: z.string().optional(),
        clubYear: z.coerce.number().int().optional(),
      })
      .parse(req.query ?? {});
    if (q.clubYear != null) {
      return listChampionships(db, { clubYear: q.clubYear });
    }
    if (q.seasonId) {
      return listChampionships(db, { seasonId: q.seasonId });
    }
    return listChampionships(db);
  });

  app.post("/api/championships", async (req, reply) => {
    const body = createBody.parse(req.body);
    try {
      return createChampionship(db, body);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/championships/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = getChampionshipDetail(db, id);
    if (!detail) return reply.code(404).send({ error: "championship_not_found" });
    return detail;
  });

  app.delete("/api/championships/:id", async (req) => {
    const { id } = req.params as { id: string };
    deleteChampionship(db, id);
    return { ok: true };
  });

  app.post("/api/championships/:id/entries", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = entryBody.parse(req.body);
    try {
      return addEntry(db, id, body);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch(
    "/api/championships/:id/entries/:entryId",
    async (req, reply) => {
      const { entryId } = req.params as { entryId: string };
      const body = entryPatch.parse(req.body);
      try {
        const updated = updateEntry(db, entryId, body);
        if (!updated) return reply.code(404).send({ error: "entry_not_found" });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/championships/:id/entries/:entryId",
    async (req) => {
      const { entryId } = req.params as { entryId: string };
      removeEntry(db, entryId);
      return { ok: true };
    },
  );

  app.post("/api/championships/:id/draw", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return generateDraw(db, id);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    "/api/championships/:id/draw/publish",
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return publishDraw(db, id);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.patch(
    "/api/championships/:id/matches/:matchId",
    async (req, reply) => {
      const { matchId } = req.params as { matchId: string };
      const body = matchPatch.parse(req.body);
      const updated = updateMatch(db, matchId, body);
      if (!updated) return reply.code(404).send({ error: "match_not_found" });
      return updated;
    },
  );

  app.post(
    "/api/championships/:id/email-matches",
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = stageEmailsBody.parse(req.body ?? {});
      try {
        return stageRoundOneMatchEmails(db, id, body);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
