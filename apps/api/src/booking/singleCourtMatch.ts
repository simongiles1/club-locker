import type { InferSelectModel } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { players } from "../db/schema.js";
import {
  createUssquashClient,
  type CreateMatchReservationBody,
  type UssquashClient,
} from "./clubLockerClient.js";
import { buildUssquashPlayerFromRow } from "./playerResolver.js";
import { formatReservationSlot } from "./slotMap.js";

type PlayerRow = InferSelectModel<typeof players>;

function syntheticClubMemberRow(displayName: string, ssmId: number): PlayerRow {
  return {
    id: `club-slot-book-${ssmId}`,
    externalId: String(ssmId),
    displayName,
    email: null,
    rating: "3.0",
    createdAt: new Date().toISOString(),
  };
}

export type SingleCourtMatchInput = {
  date: string;
  slotBegin: string;
  slotEnd: string;
  courtSide: "stadium" | "center";
  player1SsmId: number;
  player2SsmId: number;
  player1Name: string;
  player2Name: string;
};

function extractCreateMatchError(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === "string") return e;
    if (
      e &&
      typeof e === "object" &&
      "message" in e &&
      typeof (e as { message: unknown }).message === "string"
    ) {
      return (e as { message: string }).message;
    }
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof (data as { message: unknown }).message === "string"
  ) {
    return (data as { message: string }).message;
  }
  return null;
}

export async function runSingleCourtMatchBooking(
  config: AppConfig,
  input: SingleCourtMatchInput,
  client: UssquashClient = createUssquashClient(config),
): Promise<{ ok: boolean; status: number; data: unknown; message: string }> {
  const courtId =
    input.courtSide === "stadium"
      ? config.US_SQUASH_COURT_1_ID
      : config.US_SQUASH_COURT_2_ID;
  const slot = formatReservationSlot(input.slotBegin, input.slotEnd);
  const p1 = syntheticClubMemberRow(input.player1Name.trim(), input.player1SsmId);
  const p2 = syntheticClubMemberRow(input.player2Name.trim(), input.player2SsmId);

  const body: CreateMatchReservationBody = {
    type: "match",
    applyUserRestrictionsForAdmin: false,
    clubId: config.US_SQUASH_CLUB_ID,
    courtId,
    date: input.date,
    slot,
    isPrivate: false,
    notes: [],
    players: [
      buildUssquashPlayerFromRow(p1, String(input.player1SsmId)),
      buildUssquashPlayerFromRow(p2, String(input.player2SsmId)),
    ],
    payingForAll: false,
    MatchProperties: {
      restrictJoinByRating: false,
      matchType: 1,
      customMatchType: config.US_SQUASH_CUSTOM_MATCH_TYPE,
    },
  };

  const r = await client.createMatchReservation(config.US_SQUASH_CLUB_ID, body);
  const ok = r.status >= 200 && r.status < 300;
  const apiErr = extractCreateMatchError(r.data);
  return {
    ok,
    status: r.status,
    data: r.data,
    message: ok
      ? "Match reservation created in Club Locker."
      : apiErr ??
        `Club Locker returned HTTP ${r.status}`,
  };
}
