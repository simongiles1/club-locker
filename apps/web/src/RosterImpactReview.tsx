import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { SeasonStartRosterDiffResult } from "@squash/shared";
import { api } from "./api.js";
import { useToast } from "./toast.js";

export type CourtImpactRow = {
  weekNumber: number;
  playDate: string;
  boxNumber: number;
  slotLabel: string;
  courtId: number;
  slot: string;
  status: "mismatch" | "missing_booking" | "extra_booking" | "ok";
  managed: boolean;
  before: {
    playerNames: [string, string] | null;
    ussquashPlayerIds: [number, number] | null;
    reservationId: string | null;
    occurrenceId: string | null;
  };
  after: {
    playerNames: [string, string];
    ussquashPlayerIds: [number, number];
  } | null;
};

export type EmailImpactRow = {
  kind: "weekly_box" | "season_box_eml" | "match_reminder";
  weekNumber: number | null;
  boxNumber: number | null;
  label: string;
  alreadySent: boolean;
  sentAt: string | null;
  action: "force_resend" | "regenerate_download" | "info_only";
  detail?: string;
};

export type RosterImpactPayload = {
  seasonId: string;
  asOfDate: string;
  convertedWeeks: number[];
  weeksScanned: number[];
  courtRows: CourtImpactRow[];
  emailRows: EmailImpactRow[];
  blockers: { weekNumber: number; issues: { reason: string }[] }[];
  court1Id: number;
  court2Id: number;
  summary: {
    courtSlotsNeedingUpdate: number;
    weeksWithCourtChanges: number[];
    boxesForSeasonEml: number[];
  };
};

function emailRowKey(row: EmailImpactRow): string {
  return `${row.kind}|${row.weekNumber ?? ""}|${row.boxNumber ?? ""}|${row.label}`;
}

export function RosterImpactReview({
  seasonId,
  open,
  onClose,
  weekFilter,
  onApplied,
}: {
  seasonId: string;
  open: boolean;
  onClose: () => void;
  weekFilter: "current_and_future" | "all_converted";
  onApplied?: () => void;
}) {
  const { show, error } = useToast();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RosterImpactPayload | null>(null);
  const [includePastWeeks, setIncludePastWeeks] = useState(false);
  const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [applyBookingsBusy, setApplyBookingsBusy] = useState(false);
  const [applyEmailsBusy, setApplyEmailsBusy] = useState(false);
  const [bookingsApplied, setBookingsApplied] = useState(false);
  const [seasonStartDiff, setSeasonStartDiff] =
    useState<SeasonStartRosterDiffResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter = includePastWeeks ? "all_converted" : weekFilter;
      const q = new URLSearchParams({ weekFilter: filter });
      const [payload, diffPayload] = await Promise.all([
        api<RosterImpactPayload>(
          `/api/seasons/${seasonId}/house-league/roster-impact?${q}`,
        ),
        api<SeasonStartRosterDiffResult>(
          `/api/seasons/${seasonId}/season-start-roster/diff`,
        ).catch(() => null),
      ]);
      setData(payload);
      setSeasonStartDiff(diffPayload);
      const weeks = new Set(
        payload.courtRows
          .filter((r) => r.status !== "ok")
          .map((r) => r.weekNumber),
      );
      setSelectedWeeks(weeks);
      const emailKeys = new Set(
        payload.emailRows
          .filter((r) => r.action === "force_resend")
          .map(emailRowKey),
      );
      setSelectedEmails(emailKeys);
      setBookingsApplied(false);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [seasonId, weekFilter, includePastWeeks, error]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const courtChanges = useMemo(
    () => data?.courtRows.filter((r) => r.status !== "ok") ?? [],
    [data],
  );

  const weeklyEmailRows = useMemo(
    () =>
      data?.emailRows.filter(
        (r) => r.kind === "weekly_box" && r.action === "force_resend",
      ) ?? [],
    [data],
  );

  const seasonEmlRows = useMemo(
    () => data?.emailRows.filter((r) => r.kind === "season_box_eml") ?? [],
    [data],
  );

  const reminderNotes = useMemo(
    () => data?.emailRows.filter((r) => r.kind === "match_reminder") ?? [],
    [data],
  );

  const toggleWeek = (w: number) => {
    setSelectedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(w)) next.delete(w);
      else next.add(w);
      return next;
    });
  };

  const toggleEmail = (key: string) => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const applyBookings = async () => {
    if (selectedWeeks.size === 0) {
      error("Select at least one week to update court bookings.");
      return;
    }
    setApplyBookingsBusy(true);
    try {
      const out = await api<{
        ok: boolean;
        message: string;
        weeks: { weekNumber: number; error?: string }[];
      }>(
        `/api/seasons/${seasonId}/house-league/roster-impact/apply-bookings`,
        {
          method: "POST",
          body: JSON.stringify({
            weekNumbers: [...selectedWeeks].sort((a, b) => a - b),
            confirm: true,
          }),
        },
      );
      if (out.ok) {
        show(out.message);
        setBookingsApplied(true);
        onApplied?.();
        await load();
      } else {
        error(out.message);
      }
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyBookingsBusy(false);
    }
  };

  const applyEmails = async () => {
    const weeklyMap = new Map<number, number[]>();
    for (const row of weeklyEmailRows) {
      const key = emailRowKey(row);
      if (!selectedEmails.has(key) || row.weekNumber == null) continue;
      const list = weeklyMap.get(row.weekNumber) ?? [];
      if (row.boxNumber != null) list.push(row.boxNumber);
      weeklyMap.set(row.weekNumber, list);
    }
    const weekly = [...weeklyMap.entries()].map(([weekNumber, boxNumbers]) => ({
      weekNumber,
      boxNumbers: boxNumbers.length > 0 ? boxNumbers : undefined,
    }));
    if (weekly.length === 0) {
      error("Select at least one weekly email to send.");
      return;
    }
    setApplyEmailsBusy(true);
    try {
      const out = await api<{ ok: boolean; message: string }>(
        `/api/seasons/${seasonId}/house-league/roster-impact/apply-emails`,
        {
          method: "POST",
          body: JSON.stringify({ weekly, confirm: true }),
        },
      );
      show(out.message);
      onApplied?.();
      await load();
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyEmailsBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="houseleague-setup-sidebar-backdrop"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <aside
        className="houseleague-setup-sidebar roster-impact-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="roster-impact-title"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="houseleague-setup-sidebar-top">
          <h2 id="roster-impact-title" className="houseleague-setup-sidebar-heading">
            Roster impact review
          </h2>
          <button
            type="button"
            className="houseleague-setup-sidebar-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div className="houseleague-setup-sidebar-body">
        <p className="houseleague-status roster-impact-intro">
          Compare live US Squash roster to stored court bookings (boxes 1–16) and
          recommended emails. Update courts first, then re-send weekly mail.
        </p>

        {seasonStartDiff?.summary.hasGroundTruth &&
        seasonStartDiff.summary.hasChanges ? (
          <p className="houseleague-status roster-impact-season-start-note">
            Season-start changes:{" "}
            <strong>
              {seasonStartDiff.summary.moved +
                seasonStartDiff.summary.addedOnLive +
                seasonStartDiff.summary.removedFromLive}
            </strong>{" "}
            player
            {seasonStartDiff.summary.moved +
              seasonStartDiff.summary.addedOnLive +
              seasonStartDiff.summary.removedFromLive ===
            1
              ? ""
              : "s"}{" "}
            differ from ground truth (
            {seasonStartDiff.summary.moved} moved,{" "}
            {seasonStartDiff.summary.addedOnLive} added on Club Locker,{" "}
            {seasonStartDiff.summary.removedFromLive} removed).
          </p>
        ) : null}

        <label className="roster-impact-filter">
          <input
            type="checkbox"
            checked={includePastWeeks}
            onChange={(e) => setIncludePastWeeks(e.target.checked)}
          />
          Include past converted weeks
        </label>

        {loading ? (
          <p className="houseleague-status">Loading impact…</p>
        ) : null}

        {data && !loading ? (
          <>
            {data.blockers.length > 0 ? (
              <div
                className="houseleague-banner houseleague-banner--error"
                role="alert"
              >
                <strong>Cannot book some weeks until roster is complete.</strong>
                <ul className="roster-impact-blocker-list">
                  {data.blockers.map((b) => (
                    <li key={b.weekNumber}>
                      Week {b.weekNumber}: {b.issues[0]?.reason ?? "Unresolved"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <section className="roster-impact-section">
              <h3>Court bookings (boxes 1–16)</h3>
              {courtChanges.length === 0 ? (
                <p className="houseleague-status houseleague-status--muted">
                  No court booking differences in scanned weeks.
                </p>
              ) : (
                <>
                  <p className="houseleague-status">
                    <strong>{data.summary.courtSlotsNeedingUpdate}</strong> slot
                    {data.summary.courtSlotsNeedingUpdate === 1 ? "" : "s"} need
                    updates across weeks{" "}
                    {data.summary.weeksWithCourtChanges.join(", ")}.
                  </p>
                  <div className="houseleague-table-wrap roster-impact-table-wrap">
                    <table className="houseleague-table">
                      <thead>
                        <tr>
                          <th scope="col">Week</th>
                          <th scope="col">Use</th>
                          <th scope="col">Box</th>
                          <th scope="col">Date</th>
                          <th scope="col">Before</th>
                          <th scope="col">After</th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {courtChanges.map((row) => (
                          <tr key={`${row.weekNumber}-${row.playDate}-${row.boxNumber}-${row.slot}-${row.courtId}`}>
                            <td>{row.weekNumber}</td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Update week ${row.weekNumber}`}
                                checked={selectedWeeks.has(row.weekNumber)}
                                onChange={() => toggleWeek(row.weekNumber)}
                              />
                            </td>
                            <td>{row.boxNumber}</td>
                            <td>{row.playDate}</td>
                            <td>
                              {row.before.playerNames
                                ? `${row.before.playerNames[0]} vs ${row.before.playerNames[1]}`
                                : "—"}
                            </td>
                            <td>
                              {row.after
                                ? `${row.after.playerNames[0]} vs ${row.after.playerNames[1]}`
                                : "—"}
                            </td>
                            <td>{row.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="primary roster-impact-action"
                    disabled={
                      applyBookingsBusy ||
                      selectedWeeks.size === 0 ||
                      data.blockers.length > 0
                    }
                    onClick={() => void applyBookings()}
                  >
                    {applyBookingsBusy
                      ? "Updating courts…"
                      : "Update selected court bookings"}
                  </button>
                </>
              )}
            </section>

            <section className="roster-impact-section">
              <h3>Emails</h3>
              {weeklyEmailRows.length === 0 &&
              seasonEmlRows.length === 0 &&
              reminderNotes.length === 0 ? (
                <p className="houseleague-status houseleague-status--muted">
                  No email follow-up recommended for scanned weeks.
                </p>
              ) : (
                <>
                  {weeklyEmailRows.length > 0 ? (
                    <div className="houseleague-table-wrap roster-impact-table-wrap">
                      <table className="houseleague-table">
                        <thead>
                          <tr>
                            <th scope="col">Send</th>
                            <th scope="col">Item</th>
                            <th scope="col">Sent?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {weeklyEmailRows.map((row) => {
                            const key = emailRowKey(row);
                            return (
                              <tr key={key}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={selectedEmails.has(key)}
                                    onChange={() => toggleEmail(key)}
                                  />
                                </td>
                                <td>
                                  {row.label}
                                  {row.detail ? (
                                    <span className="roster-impact-detail">
                                      {" "}
                                      — {row.detail}
                                    </span>
                                  ) : null}
                                </td>
                                <td>
                                  {row.alreadySent
                                    ? `Yes${row.sentAt ? ` (${row.sentAt.slice(0, 10)})` : ""}`
                                    : "No"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {seasonEmlRows.length > 0 ? (
                    <p className="houseleague-status">
                      Regenerate season box .eml from the{" "}
                      <strong>Emails</strong> tab for boxes:{" "}
                      {[
                        ...new Set(
                          seasonEmlRows
                            .map((r) => r.boxNumber)
                            .filter((n): n is number => n != null),
                        ),
                      ].join(", ")}
                      .
                    </p>
                  ) : null}
                  {reminderNotes.map((row) => (
                    <p
                      key={emailRowKey(row)}
                      className="houseleague-status roster-impact-reminder-note"
                    >
                      {row.detail}
                    </p>
                  ))}
                  <button
                    type="button"
                    className="secondary roster-impact-action"
                    disabled={
                      applyEmailsBusy ||
                      weeklyEmailRows.length === 0 ||
                      !bookingsApplied && courtChanges.length > 0
                    }
                    title={
                      !bookingsApplied && courtChanges.length > 0
                        ? "Update court bookings first"
                        : undefined
                    }
                    onClick={() => void applyEmails()}
                  >
                    {applyEmailsBusy
                      ? "Sending…"
                      : "Force resend selected weekly emails"}
                  </button>
                  {!bookingsApplied && courtChanges.length > 0 ? (
                    <p className="houseleague-status houseleague-status--muted">
                      Update court bookings before weekly resend when managed
                      court lines changed.
                    </p>
                  ) : null}
                </>
              )}
            </section>
          </>
        ) : null}
        </div>
      </aside>
    </div>
  );
}
