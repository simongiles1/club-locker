import type { AppConfig } from "../config.js";

type Json = Record<string, unknown>;

export type CreateClinicBody = {
  name: string;
  description: string | null;
  date: string;
  level: string;
  maximumPlayers: number;
  recurring: boolean;
  repeatEveryNumberOfWeeks: number;
  numberOfRepeats: number;
  players: unknown[];
  slots: { begin: string; end: string; court: { id: number } }[];
  isPrivate: boolean;
  color: string | null;
  notes: unknown[];
  customMatchType: string | null;
  customPrice: string | null;
  coach: string | null;
  coach2: string | null;
  coach3: string | null;
  coach4: string | null;
  ratingMinimum: number | null;
  ratingMaximum: number | null;
};

export type CreateMatchReservationBody = {
  type: "match";
  applyUserRestrictionsForAdmin: boolean;
  clubId: number;
  courtId: number;
  date: string;
  slot: string;
  isPrivate: boolean;
  notes: unknown[];
  players: unknown[];
  payingForAll: boolean;
  MatchProperties: {
    restrictJoinByRating: boolean;
    matchType: number;
    customMatchType: number;
  };
};

/**
 * US Squash API sometimes returns a single id or nested structure — normalize for storage
 */
export function extractReservationIdsFromClinicResponse(data: unknown): string[] {
  if (data == null) return [];
  if (typeof data === "object" && data !== null) {
    const o = data as Json;
    if (Array.isArray(o.reservationIds)) {
      return o.reservationIds.map((x) => String(x));
    }
  }
  if (typeof data === "object" && "id" in (data as object)) {
    const id = (data as { id: unknown }).id;
    if (typeof id === "number" || typeof id === "string") {
      return [String(id)];
    }
  }
  if (typeof data === "object" && data !== null) {
    const o = data as Json;
    if (o.reservationId != null) return [String(o.reservationId)];
    if (o.reservation != null && typeof o.reservation === "object") {
      const r = o.reservation as { id?: unknown };
      if (r.id != null) return [String(r.id)];
    }
  }
  return [];
}

function authHeaders(
  config: AppConfig,
): { Authorization: string; "content-type": string } {
  if (!config.US_SQUASH_BEARER_TOKEN) {
    throw new Error("US_SQUASH_BEARER_TOKEN is not set");
  }
  return {
    Authorization: `Bearer ${config.US_SQUASH_BEARER_TOKEN}`,
    "content-type": "application/json",
  };
}

function liveRequestHeaders(config: AppConfig): Headers {
  const h = new Headers(authHeaders(config));
  if (config.US_SQUASH_SESSION_COOKIE) {
    h.set("Cookie", config.US_SQUASH_SESSION_COOKIE);
  }
  return h;
}

const mockClubMembersRow = {
  ssmId: 561_915,
  lastLogin: "2026-04-16T16:24:57.000Z",
  firstName: "Francois",
  lastName: "Abbott",
  email: "fa@francoisabbott.com",
  cellPhone: "",
  workPhone: null,
  homePhone: null,
  sex: "M",
  profilePictureUrl: null,
  city: "",
  address1: "",
  address2: "",
  birthDate: "03/08/1990",
  age: 36,
  zip: null,
  country: "",
  state: null,
  stateName: null,
  rtoId: null,
  memberType: "<Unspecified>",
  memberTypeId: 0,
  expiration: null,
  subscriptionStatus: null,
  customId: "62271",
  customId2: "0",
  customId3: null,
  spin: null,
  homeClub: null,
  citizenship: "",
  accountVerified: false,
  optInComms: "N",
  optInSmsComms: false,
  optInPushComms: false,
  globalPushOptIn: "N",
  note: "",
  bio: null,
  userName: "Francois",
  ratingSingles: 2.86,
  ratingDoubles: null,
  ratingWprSocial: null,
  ratingWprCompetition: null,
  rtoSinglesHcap: null,
  rtoDoublesHcap: null,
  tmpRatingSingles: null,
  tmpRatingDoubles: null,
  childOrganizationOfBulkImportedPlayer: null,
  hasAgreementsSigned: "No",
  affiliatedOn: "2026-04-02T01:10:42",
};

async function readJson(
  res: Response,
): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function normalizeMembersResponse(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["members", "data", "items", "rows", "results"]) {
      const v = o[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function getSsmId(row: unknown): number | null {
  if (row && typeof row === "object" && "ssmId" in row) {
    const v = (row as { ssmId: unknown }).ssmId;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function mergeMemberBatch(
  batch: unknown[],
  seen: Set<number>,
  into: unknown[],
): void {
  for (const row of batch) {
    const id = getSsmId(row);
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    into.push(row);
  }
}

/** Normalize API responses that should be JSON arrays (box leagues, players). */
export function normalizeJsonArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["data", "items", "rows", "results"]) {
      const v = o[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function mockBoxLeagueEvents(clubId: number): unknown[] {
  return [
    {
      eventId: 10_349,
      eventTypeId: 7,
      eventName: "Cambridge Club Spring House League 2026",
      startDate: "2026-03-30T00:00:00",
      endDate: "2026-05-25T00:00:00",
      clubName: "The Cambridge Club",
      clubId,
      eventTypeName: "Box League",
      hidden: false,
      numBoxes: 28,
      numPlayers: 163,
      sportId: 3,
    },
    {
      eventId: 10_129,
      eventTypeId: 7,
      eventName: "Cambridge Club Winter House League",
      startDate: "2026-01-05T00:00:00",
      endDate: "2026-03-02T00:00:00",
      clubName: "The Cambridge Club",
      clubId,
      eventTypeName: "Box League",
      hidden: true,
      numBoxes: 32,
      numPlayers: 185,
      sportId: 3,
    },
  ];
}

/** Mock-only: persisted box level changes until process restart. */
const mockBoxLeaguePlayerLevelOverrides = new Map<string, number>();

function mockBoxLeaguePlayers(eventId: number): unknown[] {
  const names = [
    ["Alex", "Smith"],
    ["Jordan", "Lee"],
    ["Taylor", "Murphy"],
    ["Casey", "Brown"],
    ["Sam", "Adams"],
    ["Riley", "Chen"],
  ];
  return names.map(([firstName, lastName], i) => ({
    id: 230_000 + eventId + i,
    firstName,
    lastName,
    partnerId: null,
    partnerFirstName: null,
    partnerLastName: null,
    level: (i % 4) + 1,
    pointsSeason: 40 + i,
    winsSeason: 5 + i,
    lossesSeason: 3,
    prevBox: 1,
    prevBoxRank: i + 1,
    rating: 4.2 + i * 0.05,
    partnerRating: null,
    playerCurrentRank: i + 1,
  }));
}

export function createUssquashClient(config: AppConfig) {
  const base = config.US_SQUASH_API_BASE.replace(/\/$/, "");
  if (config.US_SQUASH_MODE === "mock") {
    return {
      async createClinic(
        _clubId: number,
        body: CreateClinicBody,
      ): Promise<{ data: unknown; status: number }> {
        if (body.recurring) {
          const occurrences = (body.numberOfRepeats ?? 0) + 1;
          const perOcc = body.slots.length;
          const reservationIds: string[] = [];
          for (let w = 0; w < occurrences; w++) {
            for (let s = 0; s < perOcc; s++) {
              reservationIds.push(
                `m-${String(body.date)}-w${w + 1}-s${s}`,
              );
            }
          }
          return {
            status: 201,
            data: {
              id: Math.floor(8_000_000 + Math.random() * 1_000_000),
              reservationIds,
              _mock: true,
              _recurring: true,
              _occurrences: occurrences,
            },
          };
        }
        const id = Math.floor(8_000_000 + Math.random() * 1_000_000);
        return {
          status: 201,
          data: {
            id,
            _mock: true,
            _slots: body.slots.length,
            date: body.date,
          },
        };
      },
      async deleteReservation(
        reservationId: string,
        _notify: boolean,
      ): Promise<{ status: number; data: unknown }> {
        return { status: 200, data: { deleted: reservationId, _mock: true } };
      },
      async createMatchReservation(
        _clubId: number,
        _body: CreateMatchReservationBody,
      ): Promise<{ status: number; data: unknown }> {
        return {
          status: 201,
          data: {
            id: Math.floor(9_000_000 + Math.random() * 1_000_000),
            _mock: true,
          },
        };
      },
      async listClubMembers(
        _clubId: number,
      ): Promise<{ status: number; data: unknown }> {
        const n = config.US_SQUASH_MEMBERS_MOCK_COUNT;
        const firstNames = [
          "Alex",
          "Sam",
          "Jordan",
          "Taylor",
          "Casey",
          "Riley",
          "Morgan",
        ];
        const data = Array.from({ length: n }, (_, i) => ({
          ...mockClubMembersRow,
          ssmId: 900_000 + i,
          firstName: firstNames[i % firstNames.length]!,
          lastName: `Player${i + 1}`,
          email: `player${i + 1}@example.test`,
          userName: `player${i + 1}`,
          customId: String(62_000 + i),
          ratingSingles:
            Math.round((2.5 + (i % 35) * 0.08 + (i % 3) * 0.01) * 100) / 100,
          ratingDoubles: i % 7 === 0 ? 3 + (i % 15) * 0.07 : null,
          lastLogin: i % 3 === 0 ? mockClubMembersRow.lastLogin : null,
        }));
        return { status: 200, data };
      },
      async listBoxLeaguesForClub(
        clubId: number,
      ): Promise<{ status: number; data: unknown }> {
        return {
          status: 200,
          data: mockBoxLeagueEvents(clubId),
        };
      },
      async listBoxLeaguePlayers(
        eventId: number,
      ): Promise<{ status: number; data: unknown }> {
        const rows = mockBoxLeaguePlayers(eventId).map((row) => {
          const r = row as { id: number };
          const key = `${eventId}:${r.id}`;
          const level = mockBoxLeaguePlayerLevelOverrides.get(key);
          if (level == null) return row;
          return { ...r, level };
        });
        return {
          status: 200,
          data: rows,
        };
      },
      async updateBoxLeaguePlayerLevel(
        eventId: number,
        playerId: number,
        level: number,
      ): Promise<{ status: number; data: unknown }> {
        mockBoxLeaguePlayerLevelOverrides.set(
          `${eventId}:${playerId}`,
          level,
        );
        return { status: 200, data: { ok: true, _mock: true } };
      },
    };
  }

  if (!config.US_SQUASH_BEARER_TOKEN) {
    throw new Error("US_SQUASH_MODE=live requires US_SQUASH_BEARER_TOKEN");
  }

  return {
    async createClinic(
      clubId: number,
      body: CreateClinicBody,
    ): Promise<{ data: unknown; status: number }> {
      const res = await fetch(
        `${base}/clubs/${clubId}/clinics`,
        {
          method: "POST",
          headers: authHeaders(config),
          body: JSON.stringify(body),
        },
      );
      const data = await readJson(res);
      return { data, status: res.status };
    },

    async deleteReservation(
      reservationId: string,
      notify: boolean,
    ): Promise<{ status: number; data: unknown }> {
      const res = await fetch(
        `${base}/reservations/${reservationId}?notifyUsers=${notify ? "true" : "false"}`,
        { method: "DELETE", headers: authHeaders(config) },
      );
      const data = await readJson(res);
      return { data, status: res.status };
    },

    async createMatchReservation(
      clubId: number,
      body: CreateMatchReservationBody,
    ): Promise<{ status: number; data: unknown }> {
      const res = await fetch(`${base}/clubs/${clubId}/reservations`, {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      return { status: res.status, data };
    },

    async listClubMembers(
      clubId: number,
    ): Promise<{ status: number; data: unknown }> {
      const pageSize = config.US_SQUASH_MEMBERS_PAGE_SIZE;
      const urlBase = `${base}/clubs/${clubId}/members2`;
      const headers = liveRequestHeaders(config);

      const res0 = await fetch(urlBase, { method: "GET", headers });
      const raw0 = await readJson(res0);
      if (!res0.ok) return { status: res0.status, data: raw0 };

      const first = normalizeMembersResponse(raw0);
      const seen = new Set<number>();
      const all: unknown[] = [];
      mergeMemberBatch(first, seen, all);

      if (first.length === pageSize) {
        let offset = pageSize;
        for (let p = 0; p < 100; p++) {
          const qs = new URLSearchParams({
            limit: String(pageSize),
            offset: String(offset),
          });
          const res = await fetch(`${urlBase}?${qs}`, { method: "GET", headers });
          const raw = await readJson(res);
          if (!res.ok) break;
          const batch = normalizeMembersResponse(raw);
          if (batch.length === 0) break;
          const before = all.length;
          mergeMemberBatch(batch, seen, all);
          if (batch.length < pageSize) break;
          if (all.length === before) break;
          offset += pageSize;
        }
      }

      return { status: 200, data: all };
    },

    async listBoxLeaguesForClub(
      clubId: number,
    ): Promise<{ status: number; data: unknown }> {
      const url = `${base}/box_leagues/for_club/${clubId}`;
      const res = await fetch(url, {
        method: "GET",
        headers: liveRequestHeaders(config),
      });
      const data = await readJson(res);
      return { data, status: res.status };
    },

    async listBoxLeaguePlayers(
      eventId: number,
    ): Promise<{ status: number; data: unknown }> {
      const url = `${base}/box_leagues/${eventId}/players`;
      const res = await fetch(url, {
        method: "GET",
        headers: liveRequestHeaders(config),
      });
      const data = await readJson(res);
      return { data, status: res.status };
    },

    async updateBoxLeaguePlayerLevel(
      eventId: number,
      playerId: number,
      level: number,
    ): Promise<{ status: number; data: unknown }> {
      const url = `${base}/box_leagues/${eventId}/players/${playerId}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: liveRequestHeaders(config),
        body: JSON.stringify({ level }),
      });
      const data = await readJson(res);
      return { data, status: res.status };
    },
  };
}

export type UssquashClient = ReturnType<typeof createUssquashClient>;
