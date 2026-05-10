# Project Constitution: Squash League Automation

## 1. Mission & Objectives
The goal is to automate the administrative overhead of a competitive squash house league currently involving ~192 participants at peak capacity. The system will transition the current manual 11.5-hour-per-season workload into a streamlined digital process taking approximately 1.5 hours.

## 2. Core Architecture
* **Application Type**: Initially a local web application to allow for a rich UI while maintaining local data control, with a roadmap to move to a hosted product if successful.
* **Database**: Lightweight relational database (e.g., PostgreSQL or SQLite) for structured storage of player history, box rotations, and playoff results to replace current paper records.
* **UI/UX**: A central dashboard (Option A) for the Director to review and "approve/edit" system-generated draws and bookings before execution.
* **Integration Strategy**:
    * **Club Locker**: Primary interaction via reverse-engineered network requests or Playwright/headless browser as a fallback for enrollment, ratings, and bookings.
    * **Data Sync**: Daily automated pulls from Club Locker with a "Sync Now" manual override capability.

## 3. Communication Engine
* **Provider Agnostic**: The system will use a modular "Email Adapter" to switch between services (e.g., Mailchimp, SendGrid, or direct SMTP).
* **Inbound Flow**: The system must parse incoming opt-in and opt-out emails to match player names to Club Locker records.
* **Approvals**: All outbound batch emails, including registration blasts and weekly matchups, must be staged for Director review before being dispatched.

## 4. Key Logic & Business Rules
* **Draw Creation**: Default logic follows a 2-up/2-down movement based on box standings and Club Locker ratings, with a manual adjustment layer for human review.
* **Managed vs. Self-Managed**:
    * **Boxes 1–16**: System handles matchup generation and court time assignments for director review.
    * **Boxes 17+**: System generates and sends matchup notification emails to players who arrange their own matches.
* **Playoffs**: The system will digitally calculate standings for the top 4 finishers per box and automate semi-final (1v4, 2v3) and final notification emails.

## 5. Security & Data Privacy
* **Local-First Storage**: PII (Personally Identifiable Information) such as member emails will reside in the local database to address facility security concerns.
* **Credential Management**: Club Locker and Email API credentials must be stored securely (e.g., encrypted environment variables), never hard-coded.

## 6. Success Metrics
* **V1 Efficiency**: Director spends less than 2 hours on administrative tasks per season.
* **V1 Speed**: Weekly email process for self-managed boxes takes less than 5 minutes per week.
* **V1 Accuracy**: 100% automated matchup generation using the Excel rotation code logic.
* **V2 Automation**: Achieve zero manual effort for court bookings in managed boxes and full digital integration of playoff results.