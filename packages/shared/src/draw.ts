export type PlayerSeed = {
  id: string;
  displayName: string;
  rating: number;
  /** Finishing position in prior season box (1 = best), optional */
  priorBoxFinish?: number;
};

export type BoxSuggestion = {
  boxNumber: number;
  playerIds: string[];
};

/**
 * Sort by rating descending, then stable by name.
 */
export function sortByRating(players: PlayerSeed[]): PlayerSeed[] {
  return [...players].sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Default 2-up / 2-down style adjustment: nudge ordering using prior box finish.
 * Players who finished top-2 move up in list among neighbors; bottom-2 move down.
 * This is a simplified heuristic for Phase 1; director overrides in UI.
 */
export function applyTwoUpTwoDownHeuristic(ordered: PlayerSeed[]): PlayerSeed[] {
  const withFinish = ordered.map((p, idx) => ({ p, idx, f: p.priorBoxFinish }));
  const result = [...ordered];
  for (const row of withFinish) {
    if (row.f === undefined) continue;
    if (row.f <= 2 && row.idx > 0) {
      const j = row.idx - 1;
      [result[j], result[row.idx]] = [result[row.idx], result[j]];
    } else if (row.f >= 5 && row.idx < result.length - 1) {
      const j = row.idx + 1;
      [result[j], result[row.idx]] = [result[row.idx], result[j]];
    }
  }
  return result;
}

export function chunkIntoBoxes(orderedIds: string[], boxSize = 6): BoxSuggestion[] {
  const boxes: BoxSuggestion[] = [];
  for (let i = 0, box = 1; i < orderedIds.length; i += boxSize, box++) {
    boxes.push({ boxNumber: box, playerIds: orderedIds.slice(i, i + boxSize) });
  }
  return boxes;
}

export function suggestDraw(players: PlayerSeed[]): BoxSuggestion[] {
  const sorted = sortByRating(players);
  const adjusted = applyTwoUpTwoDownHeuristic(sorted);
  return chunkIntoBoxes(adjusted.map((p) => p.id));
}
