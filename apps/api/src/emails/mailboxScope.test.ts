import { describe, expect, it } from "vitest";
import { mailboxScopeFromAliasTag } from "./mailboxScope.js";

describe("mailboxScopeFromAliasTag", () => {
  it("maps common house league aliases", () => {
    expect(mailboxScopeFromAliasTag(null)).toBe(null);
    expect(mailboxScopeFromAliasTag("")).toBe(null);
    expect(mailboxScopeFromAliasTag("hl")).toBe("house_league");
    expect(mailboxScopeFromAliasTag("house-league")).toBe("house_league");
    expect(mailboxScopeFromAliasTag("box_league")).toBe("house_league");
  });

  it("maps championship aliases", () => {
    expect(mailboxScopeFromAliasTag("champs")).toBe("championships");
    expect(mailboxScopeFromAliasTag("championships")).toBe("championships");
    expect(mailboxScopeFromAliasTag("bracket")).toBe("championships");
  });

  it("returns null for unknown tags", () => {
    expect(mailboxScopeFromAliasTag("alice")).toBe(null);
    expect(mailboxScopeFromAliasTag("random-tag")).toBe(null);
  });
});
