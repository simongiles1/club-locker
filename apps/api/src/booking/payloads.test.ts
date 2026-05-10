import { describe, expect, it } from "vitest";
import { buildManagedMatchReservations, type WeekPlanPayload } from "./payloads.js";
import type { InferSelectModel } from "drizzle-orm";
import type { players } from "../db/schema.js";

type PlayerRow = InferSelectModel<typeof players>;

describe("buildManagedMatchReservations", () => {
  const plan: WeekPlanPayload = {
    week: 1,
    boxes: [
      {
        boxId: "b1",
        boxNumber: 1,
        managed: true,
        matchups: [
          ["p1", "p2"],
          ["p3", "p4"],
        ],
        bySeatNumbers: [5, 6],
        courtPreview: [
          {
            match: [1, 2],
            court: 1,
            slotLabel: "Mon4:30",
          },
          {
            match: [3, 4],
            court: 2,
            slotLabel: "Mon4:30",
          },
        ],
      },
    ],
  };

  const playersById = new Map<string, PlayerRow>([
    [
      "p1",
      {
        id: "p1",
        externalId: "100",
        displayName: "A",
        email: null,
        rating: "5.0",
        createdAt: "",
      },
    ],
    [
      "p2",
      {
        id: "p2",
        externalId: "200",
        displayName: "B",
        email: null,
        rating: "5.1",
        createdAt: "",
      },
    ],
    [
      "p3",
      {
        id: "p3",
        externalId: "300",
        displayName: "C",
        email: null,
        rating: "4.9",
        createdAt: "",
      },
    ],
    [
      "p4",
      {
        id: "p4",
        externalId: "400",
        displayName: "D",
        email: null,
        rating: "5.0",
        createdAt: "",
      },
    ],
  ]);

  it("builds two match bodies for one managed box", () => {
    const { items, missingExternal } = buildManagedMatchReservations(
      plan,
      playersById,
      "season-1",
      "2026-04-19",
      "2026-04-20",
      10_706,
      3510,
      3512,
      457,
    );
    expect(missingExternal).toHaveLength(0);
    expect(items).toHaveLength(2);
    expect(items[0]!.body.date).toBe("2026-04-19");
    expect(items[0]!.body.courtId).toBe(3510);
    expect(items[1]!.body.date).toBe("2026-04-19");
    expect(items[1]!.body.courtId).toBe(3512);
    expect(items[0]!.body.slot).toMatch(/16:30-17:10/);
  });
});
