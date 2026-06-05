import { describe, expect, it } from "vitest";
import {
  buildOutlookEmlFile,
  mergeUniqueEmailAddresses,
  weeklyBoxEmlFilename,
} from "./emlFile.js";

describe("emlFile", () => {
  it("buildOutlookEmlFile formats From and To", () => {
    const eml = buildOutlookEmlFile({
      fromName: "Director",
      fromEmail: "dir@club.test",
      toAddresses: ["a@test", "b@test"],
      subject: "Week 2",
      htmlBody: "<p>Hi</p>",
    });
    expect(eml).toContain("From: Director <dir@club.test>");
    expect(eml).toContain("To: a@test, b@test");
    expect(eml).toContain("X-Unsent: 1");
  });

  it("mergeUniqueEmailAddresses dedupes case-insensitively", () => {
    expect(
      mergeUniqueEmailAddresses(["A@Test"], ["a@test"], ["b@test"]),
    ).toEqual(["A@Test", "b@test"]);
  });

  it("weeklyBoxEmlFilename includes week", () => {
    expect(weeklyBoxEmlFilename(3, 2)).toBe("box-03-week-2.eml");
  });
});
