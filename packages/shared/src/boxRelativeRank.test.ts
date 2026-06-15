import { describe, expect, it } from "vitest";
import {
  buildBoxScheduleSeatPlayers,
  buildBoxUiSeatRows,
  displaySeatByPlayerIdInBox,
  isScheduleSeatVacantInBox,
  livePlayerAtScheduleSeat,
  maxPlayerCurrentRankBelowBox,
  OPEN_BOX_SEAT_LABEL,
  playerNamesByRelativeRankInBox,
  relativeRankInBox,
  scheduleMatchPairNeedsCourtBooking,
  seatOrderInBox,
  type BoxRelativeRankIdentifiedPlayer,
  type BoxRelativeRankNamedPlayer,
} from "./boxRelativeRank.js";

function player(
  level: number,
  playerCurrentRank: number,
  firstName: string,
  lastName: string,
): BoxRelativeRankNamedPlayer {
  return { level, playerCurrentRank, firstName, lastName };
}

describe("boxRelativeRank", () => {
  const roster: BoxRelativeRankNamedPlayer[] = [
    ...[1, 2, 3, 4, 5, 6].map((r) => player(1, r, "B1", `P${r}`)),
    ...[7, 8, 9, 10, 11, 12].map((r) => player(2, r, "B2", `P${r - 6}`)),
    ...[13, 14, 15, 16, 17, 18].map((r) => player(3, r, "B3", `P${r - 12}`)),
  ];

  it("max below box 3 is 12 (box 2 top rank)", () => {
    expect(maxPlayerCurrentRankBelowBox(roster, 3)).toBe(12);
  });

  it("first player in box 2 has relative rank 1 (global rank 7)", () => {
    expect(relativeRankInBox(7, 2, roster)).toBe(1);
  });

  it("first player in box 3 has relative rank 1 (global rank 13)", () => {
    expect(relativeRankInBox(13, 3, roster)).toBe(1);
  });

  it("keeps season-start seats when top box players leave", () => {
    const withIds: BoxRelativeRankIdentifiedPlayer[] = [
      ...[7, 8, 9, 10, 11, 12].map((r, i) => ({
        id: 200 + i,
        level: 2,
        playerCurrentRank: r,
      })),
    ];
    const live = withIds.filter((p) => p.id !== 200 && p.id !== 201);
    const rows = buildBoxUiSeatRows(2, live, withIds);
    expect(rows.filter((r) => r.open).map((r) => r.seat)).toEqual([1, 2]);
    expect(rows.find((r) => r.playerId === 202)?.seat).toBe(3);
    expect(rows.find((r) => r.playerId === 205)?.seat).toBe(6);
    const seats = displaySeatByPlayerIdInBox({
      boxNumber: 2,
      roster: live,
      groundTruthRoster: withIds,
    });
    expect(seats.get(202)).toBe(3);
    expect(seats.get(205)).toBe(6);
  });

  it("lists new box players as unassigned until placed in a vacated seat", () => {
    const withIds: BoxRelativeRankIdentifiedPlayer[] = [
      ...[7, 8, 9, 10, 11, 12].map((r, i) => ({
        id: 200 + i,
        level: 2,
        playerCurrentRank: r,
      })),
    ];
    const live = [
      ...withIds.filter((p) => p.id !== 200 && p.id !== 201),
      { id: 999, level: 2, playerCurrentRank: 13 },
    ];
    const rows = buildBoxUiSeatRows(2, live, withIds);
    expect(rows.filter((r) => r.open).map((r) => r.seat)).toEqual([1, 2]);
    expect(rows.find((r) => r.playerId === 999)?.unassigned).toBe(true);
  });

  it("maps box 3 seats to names by relative rank", () => {
    const byRr = playerNamesByRelativeRankInBox(roster, 3);
    expect(byRr.get(1)).toBe("B3 P1");
    expect(byRr.get(6)).toBe("B3 P6");
  });

  it("seatOrderInBox uses sort order within the box only", () => {
    const withIds = roster.map((p, i) => ({ ...p, id: i + 1 }));
    expect(seatOrderInBox(7, 2, withIds)).toBe(1);
    expect(seatOrderInBox(12, 2, withIds)).toBe(6);

    const box1Shrunk = withIds.filter((p) => p.level !== 1 || p.playerCurrentRank <= 5);
    expect(seatOrderInBox(7, 2, box1Shrunk)).toBe(1);
    expect(relativeRankInBox(7, 2, box1Shrunk)).toBe(2);
  });

  it("buildBoxScheduleSeatPlayers marks unfilled vacated season-start seat as open", () => {
    const withIds = roster.map((p, i) => ({ ...p, id: i + 1 }));
    const groundTruth = withIds;
    const live = withIds.filter((p) => p.id !== 8);
    const displayName = (p: (typeof withIds)[number]) =>
      `${p.firstName} ${p.lastName}`.trim();

    const seats = buildBoxScheduleSeatPlayers({
      boxNumber: 2,
      roster: live,
      groundTruthRoster: groundTruth,
      displayName,
    });

    expect(seats.find((s) => s.seat === 2)?.displayName).toBe(OPEN_BOX_SEAT_LABEL);
    expect(seats.find((s) => s.seat === 6)?.displayName).not.toBe(OPEN_BOX_SEAT_LABEL);
    expect(seats.filter((s) => s.displayName === OPEN_BOX_SEAT_LABEL)).toHaveLength(1);
  });

  it("buildBoxScheduleSeatPlayers respects director seat override for new player", () => {
    const gt = [7, 8, 9, 10, 11, 12].map((r, i) => ({
      id: 200 + i,
      level: 2,
      playerCurrentRank: r,
    }));
    const samId = 999;
    const live = [
      ...gt.filter((p) => p.id !== 200 && p.id !== 201),
      { id: samId, level: 2, playerCurrentRank: 13 },
    ];
    const displayName = (p: (typeof live)[number]) =>
      p.id === samId ? "Sam Habib" : `Player ${p.id}`;

    const withoutOverride = buildBoxScheduleSeatPlayers({
      boxNumber: 2,
      roster: live,
      groundTruthRoster: gt,
      displayName,
    });
    expect(withoutOverride.find((s) => s.seat === 1)?.displayName).toBe("Sam Habib");
    expect(withoutOverride.find((s) => s.seat === 2)?.displayName).toBe(
      OPEN_BOX_SEAT_LABEL,
    );

    const withOverride = buildBoxScheduleSeatPlayers({
      boxNumber: 2,
      roster: live,
      groundTruthRoster: gt,
      displayName,
      seatOverrides: new Map([[samId, 2]]),
    });
    expect(withOverride.find((s) => s.seat === 1)?.displayName).toBe(
      OPEN_BOX_SEAT_LABEL,
    );
    expect(withOverride.find((s) => s.seat === 2)?.displayName).toBe("Sam Habib");
  });

  it("buildBoxScheduleSeatPlayers fills vacated seat with new player before trailing open", () => {
    const box20 = 20;
    const offset = 19 * 6;
    const groundTruth = [1, 2, 3, 4, 5].map((seat) => ({
      ...player(box20, offset + seat, "B20", `P${seat}`),
      id: offset + seat,
    }));
    const andrewId = offset + 5;
    const parsaId = 999_020;
    const live = [
      ...groundTruth.filter((p) => p.id !== andrewId),
      { ...player(box20, offset + 5, "Parsa", "Shalchi"), id: parsaId },
    ];
    const displayName = (p: (typeof live)[number]) =>
      `${p.firstName} ${p.lastName}`.trim();

    const seats = buildBoxScheduleSeatPlayers({
      boxNumber: box20,
      roster: live,
      groundTruthRoster: groundTruth,
      displayName,
    });

    expect(seats.find((s) => s.seat === 5)?.displayName).toContain("Parsa");
    expect(seats.find((s) => s.seat === 6)?.displayName).toBe(OPEN_BOX_SEAT_LABEL);
    expect(
      displaySeatByPlayerIdInBox({
        boxNumber: box20,
        roster: live,
        groundTruthRoster: groundTruth,
      }).get(parsaId),
    ).toBe(5);
  });

  it("buildBoxScheduleSeatPlayers uses live sort order without ground truth", () => {
    const withIds = roster.map((p, i) => ({ ...p, id: i + 1 }));
    const box1Shrunk = withIds.filter((p) => p.level !== 1 || p.playerCurrentRank <= 5);
    const displayName = (p: (typeof box1Shrunk)[number]) =>
      `${p.firstName} ${p.lastName}`.trim();

    const seats = buildBoxScheduleSeatPlayers({
      boxNumber: 2,
      roster: box1Shrunk,
      displayName,
    });

    expect(seats.find((s) => s.seat === 1)?.displayName).toContain("B2 P1");
    expect(seatOrderInBox(7, 2, box1Shrunk)).toBe(1);
    expect(relativeRankInBox(7, 2, box1Shrunk)).toBe(2);
  });

  it("vacant schedule seat 3 does not block unrelated 4v6 pairing", () => {
    const groundTruth: BoxRelativeRankIdentifiedPlayer[] = [];
    for (let seat = 1; seat <= 6; seat++) {
      groundTruth.push({
        id: 900 + seat,
        level: 9,
        playerCurrentRank: 48 + seat,
        firstName: "B9",
        lastName: `S${seat}`,
      });
    }
    const live = groundTruth.filter((p) => p.playerCurrentRank !== 51);
    expect(isScheduleSeatVacantInBox(9, 3, live, groundTruth)).toBe(true);
    expect(scheduleMatchPairNeedsCourtBooking(9, [4, 6], live, groundTruth)).toBe(
      true,
    );
    expect(livePlayerAtScheduleSeat(9, 4, live, groundTruth)?.id).toBe(904);
    expect(livePlayerAtScheduleSeat(9, 6, live, groundTruth)?.id).toBe(906);
  });
});
