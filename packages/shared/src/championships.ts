export type ChampionshipFormat = "singles" | "doubles";

export const CHAMPIONSHIP_DIVISION_KINDS = ["skill", "age"] as const;
export type ChampionshipDivisionKind = (typeof CHAMPIONSHIP_DIVISION_KINDS)[number];

export const SINGLES_SKILL_DIVISIONS = ["A", "B", "C", "D", "E", "F"] as const;
export const DOUBLES_SKILL_DIVISIONS = ["A", "B", "C", "D", "E"] as const;
export const AGE_DIVISIONS = ["40+", "50+"] as const;

export type SinglesSkillDivision = (typeof SINGLES_SKILL_DIVISIONS)[number];
export type DoublesSkillDivision = (typeof DOUBLES_SKILL_DIVISIONS)[number];
export type AgeDivision = (typeof AGE_DIVISIONS)[number];

export type ChampionshipDivision = {
  format: ChampionshipFormat;
  kind: ChampionshipDivisionKind;
  /** "A".."F" for skill, "40+"/"50+" for age. */
  label: string;
};

/** Stable, URL-safe identifier for a (format, kind, label) triple. */
export function divisionCode(d: ChampionshipDivision): string {
  return `${d.format}-${d.kind}-${d.label.replace(/\+/g, "plus")}`;
}

export function divisionDisplayName(d: ChampionshipDivision): string {
  const fmt = d.format === "singles" ? "Singles" : "Doubles";
  const kind =
    d.kind === "skill" ? `${d.label} Division` : `${d.label} Age`;
  return `${fmt} ${kind}`;
}

/** All divisions the club fields. Order is the canonical UI order. */
export function listAllChampionshipDivisions(): ChampionshipDivision[] {
  const out: ChampionshipDivision[] = [];
  for (const label of SINGLES_SKILL_DIVISIONS) {
    out.push({ format: "singles", kind: "skill", label });
  }
  for (const label of AGE_DIVISIONS) {
    out.push({ format: "singles", kind: "age", label });
  }
  for (const label of DOUBLES_SKILL_DIVISIONS) {
    out.push({ format: "doubles", kind: "skill", label });
  }
  for (const label of AGE_DIVISIONS) {
    out.push({ format: "doubles", kind: "age", label });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Bracket construction                                                       */
/* -------------------------------------------------------------------------- */

export type BracketEntry = {
  entryId: string;
  displayName: string;
  /** Optional partner display name for doubles teams. */
  partnerName?: string;
  /** 1-based seed; lower number = higher seed. Undefined = unseeded. */
  seed?: number | null;
};

export type BracketSlot =
  | { kind: "entry"; entryId: string; seed: number }
  | { kind: "bye" };

export type BracketMatch = {
  /** 1-based round; 1 = first round (largest), final = last round. */
  round: number;
  /** 0-based position within the round; round 1 has size/2 matches. */
  matchIndex: number;
  topSlot: BracketSlot | null;
  bottomSlot: BracketSlot | null;
};

export type Bracket = {
  /** Power-of-two bracket size (entries + byes). */
  size: number;
  /** Number of rounds = log2(size). */
  rounds: number;
  /** Round 1 matches in display order; later rounds are derived as winners advance. */
  firstRound: BracketMatch[];
};

/** Returns the next power of 2 greater than or equal to n (min 2). */
export function nextPowerOfTwo(n: number): number {
  if (n <= 2) return 2;
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

/**
 * Standard tournament seed order for a power-of-two bracket size. Returns the
 * seed numbers (1..size) in slot order so seed 1 only meets seed 2 in the
 * final, seed 1 meets seed 4 in the semis at earliest, etc.
 *
 * Example: size 8 -> [1, 8, 4, 5, 2, 7, 3, 6].
 */
export function seedSlotOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error(`seedSlotOrder: size must be a power of two >= 2 (got ${size})`);
  }
  let order: number[] = [1, 2];
  while (order.length < size) {
    const total = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, total + 1 - seed);
    }
    order = next;
  }
  return order;
}

type RngFn = () => number;

/**
 * Builds a single-elimination bracket from a list of entries.
 *
 * Behavior:
 * - Entries with explicit seeds (1..N, no duplicates) keep their seed numbers.
 * - Entries without a seed are randomly assigned to the remaining seed slots.
 * - The bracket is padded with byes to the next power of two; high seeds get
 *   the byes (i.e. seed 1 plays a bye if needed before seed 2 does, etc.).
 */
export function buildBracket(
  entries: BracketEntry[],
  rng: RngFn = Math.random,
): Bracket {
  const size = nextPowerOfTwo(Math.max(entries.length, 2));
  const rounds = Math.round(Math.log2(size));

  const seeded = entries.filter((e) => typeof e.seed === "number" && e.seed! > 0);
  const usedSeeds = new Set<number>();
  for (const e of seeded) {
    if (usedSeeds.has(e.seed!)) {
      throw new Error(`Duplicate seed ${e.seed} on entry ${e.entryId}`);
    }
    usedSeeds.add(e.seed!);
  }
  const unseeded = entries.filter(
    (e) => typeof e.seed !== "number" || e.seed! <= 0,
  );

  // Assign remaining seed numbers (1..N) to unseeded entries randomly.
  const allSeats = Array.from({ length: entries.length }, (_, i) => i + 1);
  const freeSeats = allSeats.filter((n) => !usedSeeds.has(n));
  const shuffled = shuffle(freeSeats, rng);

  const seedToEntry = new Map<number, BracketEntry>();
  for (const e of seeded) seedToEntry.set(e.seed!, e);
  for (const e of unseeded) {
    const seat = shuffled.pop();
    if (seat === undefined) throw new Error("Ran out of seed slots");
    seedToEntry.set(seat, e);
  }

  const slotOrder = seedSlotOrder(size);
  const slots: (BracketSlot | null)[] = slotOrder.map((seedNum) => {
    if (seedNum > entries.length) return { kind: "bye" } as BracketSlot;
    const ent = seedToEntry.get(seedNum);
    if (!ent) {
      throw new Error(`Missing entry for seed ${seedNum}`);
    }
    return { kind: "entry", entryId: ent.entryId, seed: seedNum };
  });

  const firstRound: BracketMatch[] = [];
  for (let i = 0; i < slots.length; i += 2) {
    firstRound.push({
      round: 1,
      matchIndex: i / 2,
      topSlot: slots[i],
      bottomSlot: slots[i + 1],
    });
  }

  return { size, rounds, firstRound };
}

/** Builds round-1 matches plus empty placeholder matches for later rounds. */
export function bracketAllRounds(bracket: Bracket): BracketMatch[][] {
  const out: BracketMatch[][] = [bracket.firstRound];
  let prev = bracket.firstRound;
  for (let r = 2; r <= bracket.rounds; r++) {
    const next: BracketMatch[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push({
        round: r,
        matchIndex: i / 2,
        topSlot: null,
        bottomSlot: null,
      });
    }
    out.push(next);
    prev = next;
  }
  return out;
}

function shuffle<T>(arr: T[], rng: RngFn): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* -------------------------------------------------------------------------- */
/* Knockout round naming (Club Championships schedule / bracket UI / email) */
/* -------------------------------------------------------------------------- */

/**
 * Canonical entrant-count keys for the season playoff schedule (`"32"` … `"2"` JSON).
 */
export const CHAMPIONSHIP_KNOCKOUT_STAGE_ORDER = [32, 16, 8, 4, 2] as const;

/**
 * Players/teams competing at the start of bracket round `round` (1 = first knockout round).
 */
export function entrantsAtBracketRoundStart(
  bracketPow2Size: number,
  round: number,
): number {
  const size = bracketPow2Size | 0;
  const r = round | 0;
  if (size < 2 || !Number.isFinite(r) || r < 1) return Math.max(size, 2);
  let n = size >>> (r - 1);
  if (!Number.isFinite(n) || n < 2) return 2;
  return Math.min(Math.max(n, 2), size);
}

/** Powers of two ≥ 2 (sizes that make sense at the start of a bracket round). */
function isBracketFieldSizePow2(n: number): boolean {
  return Number.isFinite(n) && n >= 2 && (n & (n - 1)) === 0;
}

/**
 * Labels used in the club championships schedule UI, bracket headings, and email copy.
 */
export function knockoutStageLabel(entrantsAliveAtRoundStart: number): string {
  const n = entrantsAliveAtRoundStart | 0;
  if (n <= 2) return "Final";
  if (n === 4) return "Semis";
  if (n === 8) return "Quarters";
  if (n === 16) return "Round of 16";
  if (n === 32) return "Round of 32";
  if (isBracketFieldSizePow2(n)) return `Round of ${n}`;
  return `Round of ${entrantsAliveAtRoundStart}`;
}
