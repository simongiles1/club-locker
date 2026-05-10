# SQUASH LEAGUE AUTOMATION
## Product Requirements Document (PRD)
Version 1.0 | April 2026
Prepared for: Paul (Developer) | Prepared by: Martin

---

## 1. Overview & Purpose

This document defines the requirements for automating the administration of a competitive squash house league currently operated at a Toronto recreational facility. The league runs 4 seasons per year (fall, winter, spring, summer), each lasting 8–10 weeks, with 7 weeks of regular play and 2 weeks of playoffs.

At peak (fall/winter), the league comprises 32 boxes of 6 players = ~192 active participants. Spring currently runs ~28 boxes (~168 players); summer ~22 boxes (~132 players).

The league director currently manages all administrative tasks manually — registration, draw creation, weekly scheduling, court bookings, and playoff coordination. This document captures the full current process and defines automation requirements across two phases (Phase 1 and Phase 2).

---

## 2. Current Process (Manual)

### 2.1 Registration Phase (3 weeks before season start)

- The communications department sends an email blast to ~500 squash members using an existing template. The director writes the content and adjusts dates; the comms dept sends it. The director does NOT have direct access to the 500 member emails.
- New registrants reply directly to the director's email to opt in.
- The director manually searches each new registrant in Club Locker and adds them to the enrollment waitlist via drag-and-drop.
- Returning players from the prior season are automatically re-enrolled unless they notify the director otherwise.
- Players wishing to withdraw email the director. The director manually removes them from Club Locker and sends a confirmation reply.
- This process runs over ~3 weeks. There is no secondary tracking system — Club Locker is the single source of truth for enrollment.

### 2.2 Draw Creation (once registration closes)

- All enrolled players are visible in Club Locker with their rating (scale ~2.1 to 5.2).
- The director sorts players by Club Locker rating (highest to lowest) to create an initial ranked list.
- A manual adjustment layer is then applied based on: (a) how the player finished in the previous season's box, and (b) performance in playoffs. General rule is 2-up/2-down, but with significant subjectivity — player turnover between seasons means rigid rules don't always apply.
- Playoff results are currently recorded only on paper and used informally. They are not entered into Club Locker.
- Players are placed into boxes of 6, top-to-bottom by adjusted ranking. Boxes are numbered 1–N, players within each box numbered 1–6.
- The director would like future ratings to incorporate house league and playoff results automatically, reducing the manual adjustment layer over time.

### 2.3 Weekly Match Scheduling (every Wednesday, for following week)

The season is 7 regular weeks + 2 playoff weeks. Each week the director generates matchups and communicates them to players.

**Managed boxes (currently Boxes 1–16) — court bookings handled by director:**
- Matches are booked on Monday evenings and Tuesday afternoons/evenings on 2 courts.
- Monday time slots: 4:30, 5:10, 5:50, 6:30, 7:10, 7:50, 8:30, 9:10 PM (8 slots × 2 courts = 16 match slots).
- Tuesday: similar structure (recently introduced, still being evaluated).
- A rotation code (stored in Excel spreadsheet) ensures players cycle through all time slots across the season. Week 1 matchup: 1v2, 3v4 (5 & 6 have a bye). The rotation shifts by 1 each week.
- The director currently copies box data into an AI tool to generate matchups, then manually enters each court booking into Club Locker.

**Self-managed boxes (Boxes 17–28/32) — players arrange their own matches:**
- The director emails each box to notify them of their matchups for the week.
- Email template is a standard copy-paste: informs players who they are playing, instructs them to arrange a time, book a court via the Club Locker app or through the front desk (available 6am–10pm).
- The director does NOT track whether self-managed players actually book or play their matches. Result recording is the players' responsibility.
- This emailing process currently requires ~25–30 individual emails per week (one per box for boxes 17+), with email addresses auto-populated in Outlook from prior history.

### 2.4 Result Tracking

- Players record their own results directly in Club Locker. The director does not manually enter results except occasionally when asked.
- The director monitors standings informally. Results are visible to all players within Club Locker.
- The director does not publish external standings — players can view within Club Locker.

### 2.5 Playoff Coordination (Weeks 8–9)

- After 7 regular weeks, the director reviews each box and identifies the top 4 finishers.
- Semi-final matchups: 1st vs 4th and 2nd vs 3rd within each box.
- The director emails all playoff participants with their semi-final matchup.
- Finals are held in week 9. The director emails all finalists.
- Playoff results are currently recorded only on paper. They are used to award prizes and informally to seed the next season's draw.

---

## 3. Data Sources & Systems

- **Club Locker:** Primary system of record for player enrollment, ratings, box assignments, court bookings, and results. The director interacts via the Club Locker web interface. An API may exist — to be investigated as a priority.
- **Outlook:** Used for all outbound communications to players. Email addresses are stored implicitly through Outlook's autocomplete history, not in a formal contacts database.
- **Excel spreadsheet:** Contains the rotation code for weekly matchup generation.
- **Communications department:** Controls the master email list of ~500 squash members. Director does not have direct access to this list.
- **Paper records:** Playoff results currently recorded only on paper. This is a gap to be resolved in Phase 2.

---

## 4. Key Constraints & Considerations

- **IT approval:** Any automated email sending solution must be either approved by IT or use a platform IT is likely to approve (e.g. Mailchimp). Custom SMTP solutions may be blocked or flagged.
- **Club Locker API:** Whether Club Locker exposes an API is the single most important technical question for this project. If an API exists, the product is clean and scalable. If not, browser automation (e.g. Playwright) is required — which works but is more fragile. This must be investigated before Phase 2 is scoped.
- **Email list access:** The director does not currently hold the 500-member email list. For Phase 1 automation of registration emails, either the comms dept provides the list, or the automated tool drafts content for comms to send.
- **Draw adjustment layer:** The director's goal is to make draw creation fully automated by ensuring Club Locker ratings capture house league and playoff results. Until that is achieved, Phase 1 should support human review and approval of the suggested draw.
- **No forced play:** The system should not attempt to enforce match play. Players are responsible for their own matches. The system's job is to notify and facilitate, not mandate.
- **Commercial intent:** This product is being built with the intention of commercialising it — either as a standalone SaaS product sold to other squash clubs, or as a licensed feature sold to or partnered with Club Locker directly. Club Locker was acquired by Artisan Ventures in November 2025 and is actively expanding. Architecture and code quality should reflect a product that is intended to scale beyond a single club.

---

## 5. Time Savings Analysis

All estimates are per season (8–10 weeks) unless noted.

| Task | Current — Per Season | Current — Per Week | Phase 1 — Per Season | Phase 2 — Per Season | Automation Method |
|------|---------------------|-------------------|---------------------|---------------------|-------------------|
| Registration – email blast coordination | 30 min | — | 5 min | 5 min | Mailchimp template auto-populated with season dates |
| Registration – processing opt-ins | 60 min | — | 5 min | 5 min | Auto-match reply emails to Club Locker |
| Registration – processing opt-outs | 30 min | — | 2 min | 2 min | Auto-process withdrawal emails |
| Draw creation – sorting by rating | 45 min | — | 5 min | 2 min | Auto-sort by Club Locker rating |
| Draw creation – adjustment layer | 30 min | — | 20 min | 0 min | Phase 1: human approves; Phase 2: fully automated once ratings capture all results |
| Weekly matchup generation | — | 20 min × 7 = 140 min | — | — | Auto-generate from rotation code (Phase 1) |
| Weekly emails – self-managed boxes | — | 25 min × 7 = 175 min | — | 1 min/wk | Auto-send via Mailchimp/SMTP |
| Court bookings – managed boxes (1–16) | — | 40 min × 7 = 280 min | 5 min/wk (review only) | 0 min | Phase 2: Club Locker API or browser automation |
| Playoff setup – identify top 4 per box | 45 min | — | 5 min | 5 min | Auto-calculate standings |
| Playoff emails (semis + finals) | 30 min | — | 5 min | 2 min | Auto-generate and send |
| Result recording / standings tracking | Ongoing / ad hoc | — | Minimal | Near zero | Players self-enter; system aggregates |
| **TOTAL (approx.)** | **~11.5 hrs** | **~85 min/wk** | **~1.5 hrs + ~9 min/wk** | **~30 min + ~1 min/wk** | **~90%+ time saving at Phase 2** |

*Note: Weekly time savings compound across 4 seasons per year. Total annual saving at Phase 2 is estimated at ~35–40 hours.*

---

## 6. Feature Breakdown by Phase

Phase 1 covers all core automation that can be built without dependency on Club Locker API access. Phase 2 adds court booking automation and deeper result integration, contingent on API availability.

| Feature | Phase 1 | Phase 2 | Notes |
|---------|---------|---------|-------|
| Email blast coordination | ✓ | — | Mailchimp template auto-populated with season dates |
| Opt-in registration processing | ✓ | — | Parse incoming emails, match to Club Locker, auto-enroll |
| Opt-out / withdrawal processing | ✓ | — | Parse withdrawal emails, auto-remove, send confirmation |
| Auto re-enrollment of returning players | ✓ | — | Pull prior season roster, re-enroll unless opted out |
| Draw creation – rating-based sort | ✓ | — | Pull Club Locker ratings, auto-sort into boxes |
| Draw creation – adjustment layer | ✓ | — | Phase 1: system suggests, director approves |
| Weekly matchup generation | ✓ | — | Auto-generate from rotation code |
| Weekly emails – self-managed boxes | ✓ | — | Auto-send via Mailchimp/SMTP |
| Playoff standings calculation | ✓ | — | Auto-identify top 4 per box |
| Playoff matchup emails (semis + finals) | ✓ | — | Auto-generate and send |
| IT-approved email infrastructure | ✓ | — | Mailchimp or equivalent |
| Court bookings – managed boxes 1–16 | — | ✓ | Browser automation or API into Club Locker |
| Result integration into Club Locker ratings | — | ✓ | Writes house league + playoff results back to ratings |
| Fully automated draw (no human approval needed) | — | ✓ | Dependent on ratings capturing all result data |
| Player-facing result self-entry UI | — | ✓ | Web form or email reply parsing |

---

## 7. Phase 1 — First Working Release

Phase 1 is the first working version of the product — the minimum set of features needed to genuinely solve the core administrative burden. It automates the highest time-cost, most repeatable tasks. Court booking automation is excluded from Phase 1 because it depends on resolving the Club Locker API question first. Phase 1 should be built, tested across one full season at the director's club, and proven before Phase 2 begins.

### 7.1 Registration Automation

- Parse incoming opt-in emails and match player names to Club Locker records.
- Auto-enqueue matched players for enrollment (or flag unmatched names for manual review).
- Parse opt-out emails and flag relevant player records for removal.
- Auto-send confirmation emails to players upon opt-in and opt-out processing.
- Generate re-enrollment list from prior season roster for director review.
- Email sending via Mailchimp or similar IT-approved platform.

### 7.2 Draw Generation

- Pull enrolled player list from Club Locker with ratings.
- Auto-sort players by rating into initial ranked list.
- Apply prior season results to generate suggested box placement adjustments (2-up/2-down logic as default).
- Present suggested draw to director for review and manual override before finalizing.
- Export finalized draw back to Club Locker format.

### 7.3 Weekly Matchup & Email Automation

- Import rotation code from Excel spreadsheet.
- Auto-generate weekly matchups for all boxes based on rotation logic.
- Auto-generate and send weekly matchup emails to all self-managed boxes (17+).
- For managed boxes (1–16): generate matchup schedule and court time assignments for director to review before booking.
- Email content to match current template (who is playing, instructions to book court / record score).

### 7.4 Playoff Coordination

- Auto-calculate standings at end of week 7 and identify top 4 per box.
- Generate semi-final matchups (1v4, 2v3) and auto-send notification emails.
- After semi-finals, generate final matchups and auto-send notification emails.

---

## 8. Phase 2 — Enhanced Automation

Phase 2 builds on a proven Phase 1 product. These features require either Club Locker API access or more complex browser automation, and are best tackled once Phase 1 is stable and tested across a real season.

### 8.1 Club Locker Court Booking Automation

- Investigate Club Locker API availability. If API exists: use it directly. If not: implement browser automation (e.g. Playwright) to log in and book courts programmatically.
- Auto-book all managed box matches (Boxes 1–16) for Monday and Tuesday slots based on generated matchup schedule.
- Director reviews proposed bookings before execution (safety checkpoint).
- Handle booking conflicts gracefully — flag to director for manual resolution.

### 8.2 Result Integration & Rating Updates

- Provide a simple interface (web form or email reply parsing) for players to submit playoff results.
- Write house league and playoff results into Club Locker player ratings, eliminating paper-based playoff records.
- Once ratings fully capture all results, draw generation in subsequent seasons can be fully automated with no human approval step required.

---

## 9. Open Questions for Developer

- Does Club Locker expose a public API? If so, what endpoints are available for enrollment, ratings, court bookings, and result entry? This is the single most important technical question — answer it first.
- Is Mailchimp the preferred email platform, or is there another IT-approved option already in use at the facility?
- Will the director provide a one-time export of the current player email list, or will this be sourced entirely from Club Locker records?
- What is the preferred interface for the director to review and approve the draw before it is finalized? (Web UI, spreadsheet, email summary?)
- Should the system run as a standalone web application, a scheduled script, or integrate into an existing tool the facility already uses?
- Is there a budget or hosting constraint that would affect technology choices?
- Given the commercial intent of this product, what licence or IP ownership structure should be agreed between director and developer upfront?

---

## 10. Success Criteria

- **Phase 1:** Director spends less than 2 hours on administrative tasks per season (excluding the draw review step).
- **Phase 1:** Weekly email process for self-managed boxes takes less than 5 minutes per week.
- **Phase 1:** Zero manual matchup generation — all matchups produced automatically from rotation code.
- **Phase 2:** Director spends zero time on court bookings for managed boxes.
- **Phase 2:** Playoff results captured digitally and automatically incorporated into the following season's draw.
- **Commercial:** Product is documented, tested, and structured in a way that it can be demonstrated to and licensed by Club Locker or sold independently to other squash clubs.

---

*— End of Document —*