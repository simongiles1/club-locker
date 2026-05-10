import { describe, expect, it } from "vitest";
import {
  playoffSemis,
  rankBoxStandings,
  topFourForPlayoffs,
} from "./standings.js";

describe("standings", () => {
  it("ranks by wins then losses", () => {
    const r = rankBoxStandings([
      { playerId: "a", wins: 2, losses: 1 },
      { playerId: "b", wins: 3, losses: 0 },
      { playerId: "c", wins: 2, losses: 2 },
    ]);
    expect(r[0]).toBe("b");
  });

  it("playoff semis are 1v4 and 2v3", () => {
    const s = playoffSemis(["a", "b", "c", "d"]);
    expect(s.semi1).toEqual(["a", "d"]);
    expect(s.semi2).toEqual(["b", "c"]);
  });

  it("topFour", () => {
    expect(topFourForPlayoffs(["a", "b", "c", "d", "e"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
