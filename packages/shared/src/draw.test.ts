import { describe, expect, it } from "vitest";
import { chunkIntoBoxes, sortByRating, suggestDraw } from "./draw.js";

describe("draw", () => {
  it("sorts by rating desc", () => {
    const s = sortByRating([
      { id: "a", displayName: "A", rating: 3.0 },
      { id: "b", displayName: "B", rating: 4.0 },
    ]);
    expect(s.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("chunks into boxes of 6", () => {
    const ids = Array.from({ length: 13 }, (_, i) => String(i));
    const boxes = chunkIntoBoxes(ids, 6);
    expect(boxes).toHaveLength(3);
    expect(boxes[0].playerIds).toHaveLength(6);
    expect(boxes[1].playerIds).toHaveLength(6);
    expect(boxes[2].playerIds).toHaveLength(1);
  });

  it("suggestDraw produces ordered boxes", () => {
    const players = [
      { id: "1", displayName: "P1", rating: 5.0 },
      { id: "2", displayName: "P2", rating: 4.0 },
      { id: "3", displayName: "P3", rating: 3.0 },
      { id: "4", displayName: "P4", rating: 2.0 },
      { id: "5", displayName: "P5", rating: 1.0 },
      { id: "6", displayName: "P6", rating: 0.5 },
    ];
    const boxes = suggestDraw(players);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].playerIds[0]).toBe("1");
  });
});
