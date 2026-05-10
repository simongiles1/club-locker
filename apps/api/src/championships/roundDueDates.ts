/**
 * seasons.championship_round_due_dates_json:
 * keys are entrants alive at round start (ASCII digits): `"32"`, `"16"`, `"8"`, `"4"`, `"2"`.
 * Legacy keys `"1"`, `"2"`, … (round index) remain readable for backwards compatibility.
 */

import { entrantsAtBracketRoundStart } from "@squash/shared";

export type ChampionshipRoundDueDatesMap = Record<string, string | null>;

export function parseRoundDueDatesJson(
  raw: string | null | undefined,
): ChampionshipRoundDueDatesMap {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: ChampionshipRoundDueDatesMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === "") out[k] = null;
      else if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function stringifyRoundDueDates(
  map: ChampionshipRoundDueDatesMap,
): string | null {
  const compact: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const key = String(k).trim();
    if (!/^\d+$/.test(key)) continue;
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      compact[key] = String(v).trim();
    }
  }
  return Object.keys(compact).length === 0 ? null : JSON.stringify(compact);
}

export function normalizeRoundDueDatesPayload(
  input: ChampionshipRoundDueDatesMap,
): ChampionshipRoundDueDatesMap {
  const out: ChampionshipRoundDueDatesMap = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).trim();
    if (!/^\d+$/.test(key)) continue;
    if (v === null || v === "" || String(v).trim() === "") {
      out[key] = null;
    } else {
      out[key] = String(v).trim();
    }
  }
  return out;
}

/**
 * Due dates for emailing and display: entrants-keyed JSON first,
 * legacy round-index (`"1"`…`"8"`), then championship.round_one_due_date for round 1 only.
 */
export function resolveDueDateForChampionshipRound(
  seasonRoundJson: string | null | undefined,
  bracketPow2Size: number | null | undefined,
  round: number,
  legacyRoundOneChampionship: string | null | undefined,
): string | null {
  const parsed = parseRoundDueDatesJson(seasonRoundJson);

  if (
    bracketPow2Size !== null &&
    bracketPow2Size !== undefined &&
    bracketPow2Size >= 2
  ) {
    const entrants = entrantsAtBracketRoundStart(bracketPow2Size, round);
    const hit = parsed[String(entrants)]?.trim();
    if (hit) return hit;
  }

  const legacyRound = parsed[String(round)]?.trim();
  if (legacyRound) return legacyRound;

  if (
    round === 1 &&
    legacyRoundOneChampionship?.trim()
  ) {
    return legacyRoundOneChampionship.trim();
  }

  return null;
}
