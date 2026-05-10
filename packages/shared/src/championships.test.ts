import { describe, expect, it } from "vitest";
import {
  bracketAllRounds,
  buildBracket,
  divisionCode,
  divisionDisplayName,
  entrantsAtBracketRoundStart,
  knockoutStageLabel,
  listAllChampionshipDivisions,
  nextPowerOfTwo,
  seedSlotOrder,
} from "./championships.js";

describe("entrantsAtBracketRoundStart / knockoutStageLabel", () => {
  it("matches a 32-player field through Final", () => {
    const s = 32;
    expect(
      knockoutStageLabel(entrantsAtBracketRoundStart(s, 1)),
    ).toBe("Round of 32");
    expect(
      knockoutStageLabel(entrantsAtBracketRoundStart(s, 2)),
    ).toBe("Round of 16");
    expect(knockoutStageLabel(entrantsAtBracketRoundStart(s, 3))).toBe(
      "Quarters",
    );
    expect(knockoutStageLabel(entrantsAtBracketRoundStart(s, 4))).toBe(
      "Semis",
    );
    expect(knockoutStageLabel(entrantsAtBracketRoundStart(s, 5))).toBe(
      "Final",
    );
  });

  it("uses Round of 16 as the first labeled stage for a 16-bracket", () => {
    expect(
      knockoutStageLabel(entrantsAtBracketRoundStart(16, 1)),
    ).toBe("Round of 16");
  });
});

describe("nextPowerOfTwo", () => {
  it("returns 2 for sizes <= 2", () => {
    expect(nextPowerOfTwo(0)).toBe(2);
    expect(nextPowerOfTwo(1)).toBe(2);
    expect(nextPowerOfTwo(2)).toBe(2);
  });
  it("rounds up to the next power of two", () => {
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(9)).toBe(16);
    expect(nextPowerOfTwo(17)).toBe(32);
  });
});

describe("seedSlotOrder", () => {
  it("matches standard 8-team tournament order", () => {
    expect(seedSlotOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
  it("matches standard 16-team tournament order", () => {
    expect(seedSlotOrder(16)).toEqual([
      1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11,
    ]);
  });
  it("rejects non-power-of-two sizes", () => {
    expect(() => seedSlotOrder(6)).toThrow();
  });
});

describe("buildBracket", () => {
  it("places top seed at slot 0 and seed 2 in opposite half", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      entryId: `e${i + 1}`,
      displayName: `P${i + 1}`,
      seed: i + 1,
    }));
    const b = buildBracket(entries);
    expect(b.size).toBe(8);
    expect(b.rounds).toBe(3);
    expect(b.firstRound).toHaveLength(4);
    const top = b.firstRound[0].topSlot;
    expect(top && top.kind === "entry" && top.seed).toBe(1);
    const seed2Match = b.firstRound[2];
    const s2 = seed2Match.topSlot;
    expect(s2 && s2.kind === "entry" && s2.seed).toBe(2);
  });

  it("pads with byes when entry count is not a power of two", () => {
    const entries = [
      { entryId: "a", displayName: "A", seed: 1 },
      { entryId: "b", displayName: "B", seed: 2 },
      { entryId: "c", displayName: "C", seed: 3 },
      { entryId: "d", displayName: "D", seed: 4 },
      { entryId: "e", displayName: "E", seed: 5 },
    ];
    const b = buildBracket(entries);
    expect(b.size).toBe(8);
    const slots = b.firstRound.flatMap((m) => [m.topSlot, m.bottomSlot]);
    const byes = slots.filter((s) => s && s.kind === "bye").length;
    expect(byes).toBe(3);
    const top1 = b.firstRound[0];
    expect(top1.topSlot?.kind).toBe("entry");
    expect(top1.bottomSlot?.kind).toBe("bye");
  });

  it("randomly assigns unseeded entries when seeds missing", () => {
    let n = 0;
    const fakeRng = () => {
      n += 1;
      return ((n * 0.37) % 1);
    };
    const entries = [
      { entryId: "a", displayName: "A", seed: 1 },
      { entryId: "b", displayName: "B" },
      { entryId: "c", displayName: "C" },
      { entryId: "d", displayName: "D" },
    ];
    const b = buildBracket(entries, fakeRng);
    const seeds = b.firstRound.flatMap((m) => [m.topSlot, m.bottomSlot])
      .filter((s): s is { kind: "entry"; entryId: string; seed: number } =>
        Boolean(s && s.kind === "entry"))
      .map((s) => s.seed)
      .sort((a, b) => a - b);
    expect(seeds).toEqual([1, 2, 3, 4]);
  });

  it("rejects duplicate seeds", () => {
    expect(() =>
      buildBracket([
        { entryId: "a", displayName: "A", seed: 1 },
        { entryId: "b", displayName: "B", seed: 1 },
      ]),
    ).toThrow();
  });
});

describe("bracketAllRounds", () => {
  it("returns rounds = log2(size)", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      entryId: `e${i + 1}`,
      displayName: `P${i + 1}`,
      seed: i + 1,
    }));
    const b = buildBracket(entries);
    const rounds = bracketAllRounds(b);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]).toHaveLength(4);
    expect(rounds[1]).toHaveLength(2);
    expect(rounds[2]).toHaveLength(1);
  });
});

describe("division metadata", () => {
  it("lists every documented division", () => {
    const all = listAllChampionshipDivisions();
    const labels = all.map((d) => `${d.format}-${d.kind}-${d.label}`);
    expect(labels).toContain("singles-skill-A");
    expect(labels).toContain("singles-skill-F");
    expect(labels).toContain("singles-age-40+");
    expect(labels).toContain("doubles-skill-E");
    expect(labels).toContain("doubles-age-50+");
  });
  it("formats human-readable names", () => {
    const code = divisionCode({ format: "doubles", kind: "age", label: "40+" });
    expect(code).toBe("doubles-age-40plus");
    expect(
      divisionDisplayName({ format: "singles", kind: "skill", label: "A" }),
    ).toBe("Singles A Division");
  });
});
