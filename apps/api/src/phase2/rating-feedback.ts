/**
 * Phase 2: Write house league + playoff results back into Club Locker ratings (or local augmentation).
 */
export type RatingAdjustmentInput = {
  playerId: string;
  /** Suggested delta; actual write depends on Club Locker integration */
  suggestedDelta: number;
  reason: string;
};

export async function applyRatingAdjustments(
  _inputs: RatingAdjustmentInput[],
): Promise<{ ok: false; error: string }> {
  return {
    ok: false,
    error: "Rating write-back not implemented — requires Club Locker API or approved automation",
  };
}
