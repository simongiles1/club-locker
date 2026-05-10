/** Per-player results within a box for standings (simplified: wins only). */
export type BoxResultRow = {
  playerId: string;
  wins: number;
  losses: number;
};

export function rankBoxStandings(rows: BoxResultRow[]): string[] {
  const sorted = [...rows].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.losses - b.losses;
  });
  return sorted.map((r) => r.playerId);
}

export function topFourForPlayoffs(rankedPlayerIds: string[]): string[] {
  return rankedPlayerIds.slice(0, 4);
}

export function playoffSemis(pair: [string, string, string, string]): {
  semi1: [string, string];
  semi2: [string, string];
} {
  const [p1, p2, p3, p4] = pair;
  return {
    semi1: [p1, p4],
    semi2: [p2, p3],
  };
}
