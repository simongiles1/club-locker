import { describe, expect, it } from "vitest";
import { extractReservationIdsFromClinicResponse } from "./clubLockerClient.js";

describe("extractReservationIdsFromClinicResponse", () => {
  it("reads top-level id", () => {
    expect(extractReservationIdsFromClinicResponse({ id: 4695432 })).toEqual([
      "4695432",
    ]);
  });

  it("reads reservationId", () => {
    expect(
      extractReservationIdsFromClinicResponse({ reservationId: "123" }),
    ).toEqual(["123"]);
  });

  it("reads reservationIds array (recurring clinic)", () => {
    expect(
      extractReservationIdsFromClinicResponse({
        reservationIds: ["a", "b", 3],
      }),
    ).toEqual(["a", "b", "3"]);
  });

  it("returns empty for unknown", () => {
    expect(extractReservationIdsFromClinicResponse({})).toEqual([]);
  });
});
