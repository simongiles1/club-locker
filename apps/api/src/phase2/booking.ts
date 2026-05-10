/**
 * Phase 2: Club Locker court booking automation.
 * Real implementation: API client or Playwright flows with director approval gates.
 */
export type BookingProposalPayload = {
  weekNumber: number;
  assignments: {
    boxNumber: number;
    match: [number, number];
    court: number;
    slotLabel: string;
  }[];
};

export async function executeBookingProposal(
  _proposalId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return {
    ok: false,
    error:
      "Booking execution not enabled — configure Club Locker API or Playwright adapter after Phase 1 pilot",
  };
}

export function validateProposalForReview(payload: BookingProposalPayload): string[] {
  const issues: string[] = [];
  if (payload.weekNumber < 1 || payload.weekNumber > 9) {
    issues.push("weekNumber should be between 1 and 9 for a typical season");
  }
  if (payload.assignments.length === 0) {
    issues.push("no assignments");
  }
  return issues;
}
