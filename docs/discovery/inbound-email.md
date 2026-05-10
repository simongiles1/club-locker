# Inbound Email: Registration Opt-In / Opt-Out

## Requirement (PRD §7.1)
Parse incoming emails, match names to Club Locker (or local roster), enqueue enroll/remove actions, and stage confirmation emails.

## Ingestion options
1. **Microsoft Graph** subscription to a dedicated mailbox folder (if IT approves app registration).
2. **IMAP polling** on a league mailbox (simpler operationally, less real-time).
3. **Manual paste / .eml upload** in director UI for pilot (fallback).

## Matching strategy
- Extract `From`, `Subject`, body text; normalize whitespace.
- Match against `players.displayName` and `players.email` with fuzzy tier:
  - **exact email** → auto
  - **exact name** (single hit) → auto
  - **multiple / none** → `needs_review` queue

## Security
Store PII only in local DB; redact logs; encrypt credentials at rest via OS secret store or env in pilot.
