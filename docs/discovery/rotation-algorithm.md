# Weekly Match Rotation (6-Player Box)

## SourcePRD §2.3: Week 1 matchup **1v2**, **3v4**; players **5 & 6** have a bye; rotation **shifts by 1** each week.

## Model (implemented in `@squash/shared`)
Treat the box as an ordered list of seats `1..6`. For week `w` (1-based), **left-rotate** the list by `(w - 1)` positions, then pair **consecutive** seats: `(0,1)` and `(2,3)` play; `(4,5)` have a bye.

This matches PRD week 1 (`1v2`, `3v4`, `5&6` bye) and shifts the pattern by one seat each week.

## Example (identity mapping week 1)
- Matches: pos1 vs pos2, pos3 vs pos4; pos5, pos6 bye.

## Example (week 2, shift +1)
- pos1 → role 6 (bye with old 5), pos2 → role 1, ...Implementation uses the formula above so it stays deterministic and testable.

## Managed boxes (1–16)
After pairs are known, assign to Monday/Tuesday slots from a configurable slot list (PRD times); implementation fills sequentially for preview until Phase 2 books courts.

## Validation
See `packages/shared/src/rotation.test.ts` (Vitest).
