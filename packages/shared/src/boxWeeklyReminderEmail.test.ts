import { describe, expect, it } from "vitest";
import {
  buildBoxWeeklyReminderContent,
  buildWeeklyBoxInterpolationVars,
  buildWeeklyMatchupInterpolationVars,
  DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
  formatWeeklyManagedBookingDetailLine,
  formatWeeklyManagedMatchLine,
  isWednesdayLocal,
  playMondayForWednesdayAnnouncement,
  renderWeeklyBoxBodyFromTemplate,
  renderWeeklyMatchupBodyFromTemplate,
  resolveTargetWeekForWednesday,
  DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
} from "./boxWeeklyReminderEmail.js";

describe("playMondayForWednesdayAnnouncement", () => {
  it("returns the next Monday after a Wednesday", () => {
    const wed = new Date(2026, 5, 10, 12, 0, 0);
    expect(wed.getDay()).toBe(3);
    expect(playMondayForWednesdayAnnouncement(wed)).toBe("2026-06-15");
  });
});

describe("resolveTargetWeekForWednesday", () => {
  it("maps Wednesday to season week number from start Monday", () => {
    const wed = new Date(2026, 5, 10, 12, 0, 0);
    const target = resolveTargetWeekForWednesday(wed, "2026-06-01");
    expect(target).not.toBeNull();
    expect(target!.weekNumber).toBe(3);
    expect(target!.playMonday).toBe("2026-06-15");
  });

  it("returns null when play week is before season start", () => {
    const wed = new Date(2026, 4, 20, 12, 0, 0);
    expect(resolveTargetWeekForWednesday(wed, "2026-06-01")).toBeNull();
  });

  it("returns null for week 8+", () => {
    const wed = new Date(2026, 7, 5, 12, 0, 0);
    expect(resolveTargetWeekForWednesday(wed, "2026-06-01")).toBeNull();
  });
});

describe("buildBoxWeeklyReminderContent", () => {
  const players = [1, 2, 3, 4, 5, 6].map((seat) => ({
    seat,
    displayName: `P${seat}`,
  }));

  it("formats managed lines from booked occurrences", () => {
    const content = buildBoxWeeklyReminderContent({
      boxNumber: 2,
      weekNumber: 1,
      players,
      weekPlayDateLabel: "Mon, 1 Jun 2026 & Tue, 2 Jun 2026",
      bookedMatches: [
        {
          player1Name: "P1",
          player2Name: "P2",
          playDate: "2026-06-01",
          slot: "19:30-20:15",
          courtLabel: "Stadium",
        },
        {
          player1Name: "P3",
          player2Name: "P4",
          playDate: "2026-06-01",
          slot: "20:15-21:00",
          courtLabel: "Court 2",
        },
      ],
    });
    expect(content.managed).toBe(true);
    expect(content.matches[0]).toContain("P1 vs P2");
    expect(content.matches[0]).toContain("Stadium");
    expect(content.matches[0]).toContain("7:30PM");
    expect(content.byeNames).toEqual(["P5", "P6"]);
  });

  it("builds unmanaged pairing-only lines", () => {
    const content = buildBoxWeeklyReminderContent({
      boxNumber: 20,
      weekNumber: 1,
      players,
      weekPlayDateLabel: "",
    });
    expect(content.managed).toBe(false);
    expect(content.matches[0]).toBe("P1 vs P2");
    expect(content.matches[0]).not.toContain("Court");
  });
});

describe("weekly templates", () => {
  it("interpolates managed weekly template", () => {
    const content = buildBoxWeeklyReminderContent({
      boxNumber: 3,
      weekNumber: 2,
      players: [1, 2, 3, 4, 5, 6].map((s) => ({
        seat: s,
        displayName: `B3-P${s}`,
      })),
      weekPlayDateLabel: "Mon, 8 Jun 2026",
      bookedMatches: [
        {
          player1Name: "A",
          player2Name: "B",
          playDate: "2026-06-08",
          slot: "18:50-19:35",
          courtLabel: "Stadium",
        },
      ],
    });
    const vars = buildWeeklyBoxInterpolationVars({
      seasonName: "Summer HL",
      content,
    });
    const html = renderWeeklyBoxBodyFromTemplate(
      DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
      vars,
    );
    expect(html).toContain("week 2");
    expect(html).toContain("Club Locker");
  });

  it("interpolates unmanaged weekly template with self-book CTA", () => {
    const content = buildBoxWeeklyReminderContent({
      boxNumber: 22,
      weekNumber: 1,
      players: [1, 2, 3, 4, 5, 6].map((s) => ({
        seat: s,
        displayName: `P${s}`,
      })),
      weekPlayDateLabel: "",
    });
    const vars = buildWeeklyBoxInterpolationVars({
      seasonName: "Summer HL",
      content,
    });
    const html = renderWeeklyBoxBodyFromTemplate(
      DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
      vars,
    );
    expect(html).toContain("Club Locker");
    expect(html).toContain("front desk");
  });
});

describe("formatWeeklyManagedMatchLine", () => {
  it("includes court and formatted slot", () => {
    const line = formatWeeklyManagedMatchLine({
      player1Name: "Ada",
      player2Name: "Bob",
      playDate: "2026-06-02",
      slot: "19:30-20:15",
      courtLabel: "Center",
    });
    expect(line).toContain("Ada vs Bob");
    expect(line).toContain("Center");
  });
});

describe("formatWeeklyManagedBookingDetailLine", () => {
  it("omits player names", () => {
    const line = formatWeeklyManagedBookingDetailLine({
      player1Name: "Bryce Kristjansson",
      player2Name: "Patrick Dacko",
      playDate: "2026-06-08",
      slot: "17:10-17:50",
      courtLabel: "Stadium",
    });
    expect(line).not.toContain("Bryce");
    expect(line).not.toContain("Patrick");
    expect(line).toContain("Mon, 8 Jun 2026");
    expect(line).toContain("Stadium");
    expect(line).toContain("5:10PM");
  });
});

describe("per-matchup weekly template", () => {
  it("uses first names in greeting and booking detail without play-week range", () => {
    const vars = buildWeeklyMatchupInterpolationVars({
      seasonName: "Summer HL",
      content: {
        boxNumber: 2,
        managed: true,
        weekNumber: 2,
        matchIndex: 1,
        matchupLine: "Mon, 8 Jun 2026, Stadium, 5:10PM–5:50PM",
        matchupShortLabel: "Bryce Kristjansson vs Patrick Dacko",
        player1Name: "Bryce Kristjansson",
        player2Name: "Patrick Dacko",
        weekPlayDateLabel: "Mon, 8 Jun 2026 & Tue, 9 Jun 2026",
      },
    });
    const html = renderWeeklyMatchupBodyFromTemplate(
      DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
      vars,
    );
    expect(html).toContain("Bryce &amp; Patrick,");
    expect(html).not.toContain("Kristjansson");
    expect(html).not.toContain("Dacko,");
    expect(html).toContain("Mon, 8 Jun 2026, Stadium, 5:10PM–5:50PM");
    expect(html).not.toContain("Mon, 8 Jun 2026 &amp; Tue, 9 Jun 2026");
  });
});

describe("isWednesdayLocal", () => {
  it("detects Wednesday", () => {
    expect(isWednesdayLocal(new Date(2026, 5, 10))).toBe(true);
    expect(isWednesdayLocal(new Date(2026, 5, 11))).toBe(false);
  });
});
