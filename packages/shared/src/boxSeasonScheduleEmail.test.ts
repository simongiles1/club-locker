import { describe, expect, it } from "vitest";
import { OPEN_BOX_SEAT_LABEL } from "./boxRelativeRank.js";
import {
  boxEmlFilename,
  buildBoxEmlInterpolationVars,
  buildBoxSeasonScheduleEmailContent,
  DEFAULT_BOX_EML_BODY_TEMPLATE,
  DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
  formatCancelledMatchupNotice,
  renderBoxEmlBodyFromTemplate,
  renderBoxSeasonScheduleEmailHtml,
  renderBoxSeasonScheduleEmailText,
} from "./boxSeasonScheduleEmail.js";

function playersForBox(boxNumber: number): {
  seat: number;
  displayName: string;
}[] {
  return [1, 2, 3, 4, 5, 6].map((seat) => ({
    seat,
    displayName: `Box${boxNumber}-P${seat}`,
  }));
}

describe("buildBoxSeasonScheduleEmailContent", () => {
  it("builds seven weekly sections with two matches each for managed box 1", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      1,
      playersForBox(1),
      "2026-06-01",
    );
    expect(content.managed).toBe(true);
    expect(content.weeks).toHaveLength(7);
    expect(content.weeks[0]!.matches).toHaveLength(2);
    expect(content.weeks[0]!.matches[0]).toContain("Box1-P1 vs Box1-P2");
    expect(content.weeks[0]!.matches[0]).toContain("Stadium");
    expect(content.weeks[0]!.byeNames).toEqual(["Box1-P5", "Box1-P6"]);
    expect(content.oneVsSixMatchLabel).toBe("Box1-P1 vs Box1-P6");
  });

  it("replaces vacant-seat pairings with cancelled notices for managed box 2", () => {
    const players = [
      { seat: 1, displayName: "Trevor Deck" },
      { seat: 2, displayName: OPEN_BOX_SEAT_LABEL },
      { seat: 3, displayName: "David Carl" },
      { seat: 4, displayName: "Dan Mitchell" },
      { seat: 5, displayName: "Matt Boland" },
      { seat: 6, displayName: "Jack Curtis" },
    ];
    const content = buildBoxSeasonScheduleEmailContent(2, players, "2026-06-01");
    const week1 = content.weeks[0]!;
    expect(week1.matches).toHaveLength(1);
    expect(week1.matches[0]).toContain("David Carl vs Dan Mitchell");
    expect(week1.matches.some((m) => m.includes("(open)"))).toBe(false);
    expect(week1.cancelledMatchups).toHaveLength(1);
    expect(week1.cancelledMatchups[0]).toContain("Trevor Deck");
    expect(week1.cancelledMatchups[0]).toContain("cancelled");
    expect(week1.cancelledMatchups[0]).toContain("Stadium");
  });

  it("omits cancelled notices for vacant-seat pairings on self-managed boxes", () => {
    const players = [
      { seat: 1, displayName: "Ari Laskin" },
      { seat: 2, displayName: "Player Two" },
      { seat: 3, displayName: "Player Three" },
      { seat: 4, displayName: "Player Four" },
      { seat: 5, displayName: "Player Five" },
      { seat: 6, displayName: OPEN_BOX_SEAT_LABEL },
    ];
    const content = buildBoxSeasonScheduleEmailContent(17, players, "2026-06-01");
    expect(content.managed).toBe(false);
    for (const week of content.weeks) {
      expect(week.cancelledMatchups).toHaveLength(0);
    }
    expect(content.oneVsSixMatchLabel).toBe("Ari Laskin vs (open)");
    expect(content.oneVsSixMatchLabel).not.toContain("cancelled");
  });

  it("builds self-managed weekly matchups for box 22 without court times", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      22,
      playersForBox(22),
      "2026-06-01",
    );
    expect(content.managed).toBe(false);
    expect(content.weeks).toHaveLength(7);
    expect(content.weeks[4]!.week).toBe(5);
    expect(content.weeks[4]!.matches[0]).toBe("Box22-P2 vs Box22-P3");
    expect(content.weeks[4]!.matches[1]).toBe("Box22-P4 vs Box22-P5");
    expect(content.weeks[4]!.byeNames).toEqual(["Box22-P1", "Box22-P6"]);
    expect(content.weeks[5]!.byeNames).toEqual(["Box22-P2", "Box22-P4"]);
  });
});

describe("buildBoxEmlInterpolationVars introScheduleNote", () => {
  it("uses season-start wording by default", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      1,
      playersForBox(1),
      "2026-06-01",
    );
    const vars = buildBoxEmlInterpolationVars({
      seasonName: "Summer House League",
      seasonStartDateLabel: "Mon, 1 Jun 2026",
      content,
    });
    expect(vars.introScheduleNote).toContain("booked court times");
    expect(vars.introScheduleNote).not.toContain("updated");
  });

  it("uses box-change wording for managed and unmanaged boxes", () => {
    const managed = buildBoxSeasonScheduleEmailContent(
      3,
      playersForBox(3),
      "2026-06-01",
    );
    const unmanaged = buildBoxSeasonScheduleEmailContent(
      22,
      playersForBox(22),
      "2026-06-01",
    );
    const managedVars = buildBoxEmlInterpolationVars(
      {
        seasonName: "Summer House League",
        seasonStartDateLabel: "Mon, 1 Jun 2026",
        content: managed,
      },
      "box_modification",
    );
    const unmanagedVars = buildBoxEmlInterpolationVars(
      {
        seasonName: "Summer House League",
        seasonStartDateLabel: "Mon, 1 Jun 2026",
        content: unmanaged,
      },
      "box_modification",
    );
    expect(managedVars.introScheduleNote).toContain("court bookings");
    expect(managedVars.introScheduleNote).toContain("updated");
    expect(unmanagedVars.introScheduleNote).toContain("roster");
    expect(unmanagedVars.introScheduleNote).not.toContain("court bookings");
    expect(unmanagedVars.introScheduleNote).toContain("Club Locker");
  });

  it("includes boxChangeReasonClause when provided", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      2,
      playersForBox(2),
      "2026-06-01",
    );
    const vars = buildBoxEmlInterpolationVars(
      {
        seasonName: "Summer House League",
        seasonStartDateLabel: "Mon, 1 Jun 2026",
        content,
      },
      "box_modification",
      { boxChangeReasonClause: " due to Anthony Berg withdrawing" },
    );
    const html = renderBoxEmlBodyFromTemplate(
      DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
      vars,
    );
    expect(html).toContain(
      "changes to your box in the <strong>Summer House League</strong> due to Anthony Berg withdrawing.",
    );
  });

  it("does not leave empty week match placeholders in box-change preview", () => {
    const players = [
      { seat: 1, displayName: "Trevor Deck" },
      { seat: 2, displayName: OPEN_BOX_SEAT_LABEL },
      { seat: 3, displayName: "David Carl" },
      { seat: 4, displayName: "Dan Mitchell" },
      { seat: 5, displayName: "Matt Boland" },
      { seat: 6, displayName: "Jack Curtis" },
    ];
    const content = buildBoxSeasonScheduleEmailContent(2, players, "2026-06-01");
    const vars = buildBoxEmlInterpolationVars(
      {
        seasonName: "Summer House League",
        seasonStartDateLabel: "Mon, 1 Jun 2026",
        content,
      },
      "box_modification",
    );
    const html = renderBoxEmlBodyFromTemplate(
      DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
      vars,
    );
    expect(html).not.toMatch(/\{\{week\d+Match[12]\}\}/);
    expect(html).not.toMatch(/\{\{week\d+CancelledBlock\}\}/);
    expect(html).toContain("Trevor Deck was scheduled for");
  });
});

describe("formatCancelledMatchupNotice", () => {
  it("includes booking detail when provided", () => {
    const line = formatCancelledMatchupNotice("Trevor Deck", {
      dateLabel: "Mon, 1 Jun 2026",
      court: "Stadium",
      timeLabel: "5:10pm–5:50pm",
    });
    expect(line).toContain("Trevor Deck was scheduled for Mon, 1 Jun 2026 on Stadium");
    expect(line).toContain("cancelled");
  });
});

describe("renderBoxEmlBodyFromTemplate", () => {
  it("interpolates placeholders from default template", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      22,
      playersForBox(22),
      "2026-06-01",
    );
    const vars = buildBoxEmlInterpolationVars({
      seasonName: "Summer House League",
      seasonStartDateLabel: "Mon, 1 Jun 2026",
      content,
    });
    const html = renderBoxEmlBodyFromTemplate(DEFAULT_BOX_EML_BODY_TEMPLATE, vars);
    expect(html).toContain("Gents of Box 22");
    expect(html).toContain("Club Locker");
    expect(html).toContain("Week 5");
    expect(html).toContain("BYE:");
    expect(html).toContain("1v6 match");
    expect(html).toContain("Any questions at all, please don");
    expect(DEFAULT_BOX_EML_BODY_TEMPLATE).toContain(
      "Any questions at all, please don&apos;t hesitate to get in touch.",
    );
  });

  it("allows custom greeting in edited template", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      3,
      playersForBox(3),
      "2026-06-01",
    );
    const vars = buildBoxEmlInterpolationVars({
      seasonName: "Summer House League",
      seasonStartDateLabel: "Mon, 1 Jun 2026",
      content,
    });
    const custom = `<p>Hello box {{boxNumber}},</p>{{weeklyScheduleSection}}`;
    const html = renderBoxEmlBodyFromTemplate(custom, vars);
    expect(html).toContain("Hello box 3");
    expect(html).toContain("Week 1");
    expect(html).not.toContain("Gents of Box");
  });
});

describe("renderBoxSeasonScheduleEmailHtml", () => {
  it("renders using the default template", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      3,
      playersForBox(3),
      "2026-06-01",
    );
    const html = renderBoxSeasonScheduleEmailHtml({
      seasonName: "Summer House League",
      seasonStartDateLabel: "Mon, 1 Jun 2026",
      content,
    });
    expect(html).toContain("Summer House League");
    expect(html).toContain("Box3-P1 vs Box3-P2");
    expect(html).toContain("Playoffs");
    expect(html).not.toContain("<table");
  });
});

describe("renderBoxSeasonScheduleEmailText", () => {
  it("matches the plain-text section layout", () => {
    const content = buildBoxSeasonScheduleEmailContent(
      22,
      playersForBox(22),
      "2026-06-01",
    );
    const text = renderBoxSeasonScheduleEmailText({
      seasonName: "Summer House League",
      seasonStartDateLabel: "Mon, 1 Jun 2026",
      content,
    });
    expect(text).toContain("Gents of Box 22");
    expect(text).toContain("WEEK 5");
    expect(text).toContain("1v6 MATCH - Please arrange on your own time");
    expect(text).toContain("BYE: Box22-P2, Box22-P4");
  });
});

describe("boxEmlFilename", () => {
  it("zero-pads box numbers", () => {
    expect(boxEmlFilename(1)).toBe("box-01.eml");
    expect(boxEmlFilename(22)).toBe("box-22.eml");
  });
});
