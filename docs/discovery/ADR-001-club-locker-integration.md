# ADR-001: Club Locker Integration Strategy

## Status
Proposed (pending facility credentials and network inspection).

## Context
Club Locker is the system of record for enrollment, ratings, box assignments, court bookings, and results. Public API documentation is not assumed available in-repo.

## Decision
1. **Primary path**: Implement a `ClubLockerClient` interface with a **mock implementation** for local development and demos.
2. **Production path A (preferred)**: If an official or reverse-engineered HTTP API is available after inspection, implement `HttpClubLockerClient` using documented or captured request shapes.
3. **Production path B (fallback)**: Implement `PlaywrightClubLockerClient` for read/write flows that lack API coverage, with explicit retry, screenshot-on-failure, and human-review gates before destructive actions.

## Consequences
- All domain logic depends on the interface, not on transport.
- Booking automation (Phase 2) stays behind an approval step regardless of transport.

## Open items
- Capture authenticated network traffic from the Club Locker web app for enrollment, roster, and booking flows.
- Confirm terms of use / automation policy with the facility and Club Locker.
