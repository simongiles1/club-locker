import { useCallback, useEffect, useState } from "react";
import {
  EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS,
  defaultBookingSeasonAndStartMonday,
  formatLocalISODate,
  interpolateEmailTemplate,
  seasonStartMondayLocal,
  type BookingCalendarSeason,
} from "@squash/shared";
import { api } from "./api.js";
import { BookingPage } from "./BookingPage.js";
import { EmailTemplateAutocompleteField } from "./EmailTemplateAutocompleteField.js";
import { ChampionshipsPage } from "./ChampionshipsPage.js";
import { HouseleaguePage } from "./HouseleaguePage.js";
import { MembersPage } from "./MembersPage.js";

type Season = {
  id: string;
  name: string;
  status: string;
  clubYear: number | null;
  calendarSegment: string | null;
  startMondayDate: string | null;
  /** Round → YYYY-MM-DD for all club championships in this season */
  championshipRoundDueDatesJson: string | null;
};

function startMondayForSeasonRow(s: Season): string {
  if (s.startMondayDate) return s.startMondayDate;
  if (
    s.calendarSegment &&
    (s.calendarSegment === "winter" ||
      s.calendarSegment === "spring" ||
      s.calendarSegment === "summer" ||
      s.calendarSegment === "fall") &&
    s.clubYear != null
  ) {
    return formatLocalISODate(
      seasonStartMondayLocal(
        s.calendarSegment as BookingCalendarSeason,
        s.clubYear,
      ),
    );
  }
  return "";
}

/** winter → spring → summer → fall — one canonical season row per club-booking year for championships. */
const CALENDAR_SEGMENT_ORDER: Record<string, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
};

function canonicalSeasonIdForClubYear(seasons: Season[], year: number): string {
  const rows = seasons.filter((s) => s.clubYear === year);
  if (rows.length === 0) return "";
  return [...rows].sort((a, b) => {
    const ao =
      a.calendarSegment != null
        ? (CALENDAR_SEGMENT_ORDER[a.calendarSegment] ?? 99)
        : 99;
    const bo =
      b.calendarSegment != null
        ? (CALENDAR_SEGMENT_ORDER[b.calendarSegment] ?? 99)
        : 99;
    return ao - bo;
  })[0]!.id;
}

function distinctClubYearsDescending(seasons: Season[]): number[] {
  const ys = new Set<number>();
  for (const s of seasons) {
    if (s.clubYear != null) ys.add(s.clubYear);
  }
  return [...ys].sort((a, b) => b - a);
}
type Tab =
  | "overview"
  | "registration"
  | "draw"
  | "weekly"
  | "houseleague"
  | "championships"
  | "emails"
  | "playoffs"
  | "phase2"
  | "booking"
  | "members";

type PlayerRow = {
  id: string;
  displayName: string;
  email: string | null;
  rating: string;
};

type DrawBox = { boxNumber: number; playerIds: string[] };

type DrawPreviewState = {
  drawVersionId: string;
  boxes: DrawBox[];
  playersById: Map<string, PlayerRow>;
  status: "draft" | "approved";
};

type WeeklyBoxPayload = {
  boxId: string;
  boxNumber: number;
  managed: boolean;
  matchups: [string | undefined, string | undefined][];
  bySeatNumbers: [number, number];
  courtPreview: {
    match: [number, number];
    court: 1 | 2;
    slotLabel: string;
  }[];
};

type WeekPlanPreviewState = {
  weekPlanId: string;
  week: number;
  boxes: WeeklyBoxPayload[];
  playersById: Map<string, PlayerRow>;
};

function WeeklyPlanPreviewCard({
  weekPlanId,
  week,
  boxes,
  playersById,
}: WeekPlanPreviewState) {
  const nameOf = (id: string | undefined) =>
    id && playersById.has(id)
      ? playersById.get(id)!.displayName
      : id
        ? `Unknown (${id.slice(0, 8)}…)`
        : "—";

  return (
    <div className="card weekly-preview">
      <h2 className="weekly-preview-title">Week {week} plan (draft)</h2>
      <p className="weekly-meta">
        Week plan ID: <code>{weekPlanId}</code>
      </p>
      {boxes.length === 0 ? (
        <p className="weekly-empty">
          No boxes in this season yet. Approve a draw first so league boxes
          exist.
        </p>
      ) : (
        <div className="weekly-boxes">
          {boxes.map((b) => (
            <section key={b.boxId} className="weekly-box">
              <div className="weekly-box-header">
                <h3>Box {b.boxNumber}</h3>
                <span
                  className={`weekly-badge ${b.managed ? "managed" : "self-managed"}`}
                >
                  {b.managed ? "Managed courts" : "Self-managed"}
                </span>
              </div>
              <h4 className="weekly-sub">Matchups</h4>
              <ul className="weekly-match-list">
                {b.matchups.map((pair, i) => (
                  <li key={i}>
                    <strong>{nameOf(pair[0])}</strong>
                    <span className="weekly-vs"> vs </span>
                    <strong>{nameOf(pair[1])}</strong>
                  </li>
                ))}
              </ul>
              <p className="weekly-byes">
                Byes (box seat numbers): {b.bySeatNumbers[0]} and{" "}
                {b.bySeatNumbers[1]}
              </p>
              {b.managed && b.courtPreview.length > 0 ? (
                <>
                  <h4 className="weekly-sub">Court schedule preview</h4>
                  <ul className="weekly-court-list">
                    {b.courtPreview.map((c, i) => (
                      <li key={i}>
                        {c.slotLabel} · Court {c.court} · seats {c.match[0]} vs{" "}
                        {c.match[1]}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function WeeklyEmailStageCard({
  week,
  ids,
}: {
  week: number;
  ids: string[];
}) {
  return (
    <div className="card weekly-email-stage">
      <h3 className="weekly-preview-title">Self-managed email drafts</h3>
      <p className="weekly-meta">
        Week {week}:{" "}
        {ids.length === 0 ? (
          <span>No new drafts (no self-managed boxes or nothing to stage).</span>
        ) : (
          <span>
            Staged <strong>{ids.length}</strong> draft
            {ids.length === 1 ? "" : "s"} in the email outbox.
          </span>
        )}
      </p>
      {ids.length > 0 ? (
        <ul className="weekly-id-list">
          {ids.map((id) => (
            <li key={id}>
              <code>{id}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DrawPreviewCard({ preview }: { preview: DrawPreviewState }) {
  const title =
    preview.status === "draft" ? "Suggested draw (draft)" : "Approved draw";
  return (
    <div className="card draw-preview">
      <h2 className="draw-preview-title">{title}</h2>
      <span
        className={`draw-preview-status ${preview.status}`}
        aria-label={`Status: ${preview.status}`}
      >
        {preview.status === "draft" ? "Draft" : "Approved"}
      </span>
      <p className="draw-version-meta">
        Draw version ID: <code>{preview.drawVersionId}</code>
      </p>
      <div className="draw-boxes">
        {preview.boxes.map((box) => (
          <section key={box.boxNumber} className="draw-box">
            <h3>Box {box.boxNumber}</h3>
            <ol className="draw-player-list">
              {box.playerIds.map((playerId) => {
                const p = preview.playersById.get(playerId);
                const label = p
                  ? `${p.displayName} · rating ${Number(p.rating).toFixed(2)}`
                  : `Unknown player (${playerId.slice(0, 8)}…)`;
                return <li key={playerId}>{label}</li>;
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState<string>("");
  const setLog = useCallback((_msg: string) => {
    /* feedback UI removed */
  }, []);

  const refreshSeasons = useCallback(async () => {
    const s = await api<Season[]>("/api/seasons");
    setSeasons(s);
    setSeasonId((cur) => {
      const def = defaultBookingSeasonAndStartMonday();
      const match = s.find(
        (row) =>
          row.calendarSegment === def.season &&
          row.clubYear === def.clubYear,
      );
      if (match) return match.id;
      if (cur && s.some((x) => x.id === cur)) return cur;
      return s[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    refreshSeasons().catch((e) => console.error(e));
  }, [refreshSeasons]);

  /** Championships are keyed by club-booking year; align with canonical segment row. */
  useEffect(() => {
    if (tab !== "championships") return;
    if (seasons.length === 0) return;
    const row = seasons.find((x) => x.id === seasonId);
    const cy = row?.clubYear;
    if (cy == null) return;
    const canon = canonicalSeasonIdForClubYear(seasons, cy);
    if (canon && canon !== seasonId) setSeasonId(canon);
  }, [tab, seasonId, seasons]);

  const seasonSelectControls = (
    <>
      <label>
        Season{" "}
        <select
          value={seasonId}
          onChange={(e) => setSeasonId(e.target.value)}
        >
          {seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status})
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="secondary" onClick={refreshSeasons}>
        Refresh
      </button>
    </>
  );

  const championshipYears = distinctClubYearsDescending(seasons);
  const championshipYearForSeasonId =
    seasons.find((x) => x.id === seasonId)?.clubYear ?? null;

  const championshipsYearControls = (
    <>
      <label>
        Year{" "}
        <select
          value={
            championshipYearForSeasonId != null
              ? String(championshipYearForSeasonId)
              : ""
          }
          onChange={(e) => {
            const raw = e.target.value;
            if (!raw) return;
            const year = Number(raw);
            if (!Number.isFinite(year)) return;
            const id = canonicalSeasonIdForClubYear(seasons, year);
            if (id) setSeasonId(id);
          }}
        >
          {championshipYears.length === 0 ? (
            <option value="">No club-booking years</option>
          ) : null}
          {championshipYearForSeasonId == null && championshipYears.length > 0 ? (
            <option value="">— pick year —</option>
          ) : null}
          {championshipYears.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="secondary" onClick={refreshSeasons}>
        Refresh
      </button>
    </>
  );

  const headerSeasonControls =
    tab === "championships" ? championshipsYearControls : seasonSelectControls;

  const selectedSeason =
    seasons.find((x) => x.id === seasonId) ?? null;

  return (
    <div
      className={
        tab === "members" ? "layout layout--fill-viewport" : "layout"
      }
    >
      <nav>
        <strong>Director</strong>
        <button
          type="button"
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={tab === "registration" ? "active" : ""}
          onClick={() => setTab("registration")}
        >
          Registration
        </button>
        <button
          type="button"
          className={tab === "draw" ? "active" : ""}
          onClick={() => setTab("draw")}
        >
          Draw
        </button>
        <button
          type="button"
          className={tab === "weekly" ? "active" : ""}
          onClick={() => setTab("weekly")}
        >
          Weekly
        </button>
        <button
          type="button"
          className={tab === "houseleague" ? "active" : ""}
          onClick={() => setTab("houseleague")}
        >
          Houseleague
        </button>
        <button
          type="button"
          className={tab === "championships" ? "active" : ""}
          onClick={() => setTab("championships")}
        >
          Championships
        </button>
        <button
          type="button"
          className={tab === "emails" ? "active" : ""}
          onClick={() => setTab("emails")}
        >
          Emails
        </button>
        <button
          type="button"
          className={tab === "playoffs" ? "active" : ""}
          onClick={() => setTab("playoffs")}
        >
          Playoffs
        </button>
        <button
          type="button"
          className={tab === "booking" ? "active" : ""}
          onClick={() => setTab("booking")}
        >
          Booking
        </button>
        <button
          type="button"
          className={tab === "members" ? "active" : ""}
          onClick={() => setTab("members")}
        >
          Members
        </button>
        <button
          type="button"
          className={tab === "phase2" ? "active" : ""}
          onClick={() => setTab("phase2")}
        >
          Phase 2
        </button>
      </nav>
      <main className={tab === "members" ? "main--fill-viewport" : undefined}>
        {tab === "booking" ? (
          <div
            className="booking-main-header"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            <h1 style={{ margin: 0 }}>Court booking</h1>
            <div className="row" style={{ margin: 0 }}>
              {headerSeasonControls}
            </div>
          </div>
        ) : tab === "houseleague" ? null : (
          <div className="row" style={{ marginBottom: "1rem" }}>
            {headerSeasonControls}
          </div>
        )}
        {tab === "overview" && (
          <Overview seasonId={seasonId} onLog={setLog} />
        )}
        {tab === "registration" && <Registration onLog={setLog} />}
        {tab === "draw" && <Draw seasonId={seasonId} onLog={setLog} />}
        {tab === "weekly" && <Weekly seasonId={seasonId} onLog={setLog} />}
        {tab === "houseleague" && <HouseleaguePage />}
        {tab === "championships" && (
          <ChampionshipsPage
            seasonId={seasonId}
            clubYear={championshipYearForSeasonId}
          />
        )}
        {tab === "emails" && <Emails seasonId={seasonId} onLog={setLog} />}
        {tab === "playoffs" && <Playoffs seasonId={seasonId} onLog={setLog} />}
        {tab === "booking" && (
          <BookingPage
            seasonId={seasonId}
            seasonStartMondayISO={
              selectedSeason ? startMondayForSeasonRow(selectedSeason) : ""
            }
            onLog={setLog}
          />
        )}
        {tab === "members" && <MembersPage />}
        {tab === "phase2" && <Phase2 seasonId={seasonId} onLog={setLog} />}
      </main>
    </div>
  );
}

function Overview({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  return (
    <div>
      <h1>Overview</h1>
      <p>
        Local-first director dashboard. Run API on port 3001; this UI proxies{" "}
        <code>/api</code>.
      </p>
      <div className="card">
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={!seasonId}
            onClick={async () => {
              const res = await api<unknown>(`/api/seasons/${seasonId}/sync`, {
                method: "POST",
              });
              onLog(JSON.stringify(res, null, 2));
            }}
          >
            Sync Now (Club Locker mock)
          </button>
        </div>
      </div>
    </div>
  );
}

function Registration({ onLog }: { onLog: (s: string) => void }) {
  return (
    <div>
      <h1>Registration queue</h1>
      <div className="card row">
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            const rows = await api<unknown[]>("/api/registration-queue");
            onLog(JSON.stringify(rows, null, 2));
          }}
        >
          Load queue
        </button>
      </div>
      <div className="card">
        <p>Simulate opt-in (uses player email in mock roster)</p>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const res = await api<unknown>("/api/registration-queue", {
              method: "POST",
              body: JSON.stringify({
                kind: "opt_in",
                fromEmail: "player1@example.test",
                parsedName: "Player 1",
              }),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Simulate opt-in player1@example.test
        </button>
      </div>
    </div>
  );
}

function Draw({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  const [drawVersionId, setDrawVersionId] = useState<string>("");
  const [preview, setPreview] = useState<DrawPreviewState | null>(null);

  return (
    <div>
      <h1>Draw</h1>
      <div className="card row">
        <button
          type="button"
          className="primary"
          disabled={!seasonId}
          onClick={async () => {
            try {
              const [playerRows, res] = await Promise.all([
                api<PlayerRow[]>("/api/players"),
                api<{ drawVersionId: string; boxes: DrawBox[] }>(
                  `/api/seasons/${seasonId}/draw/suggest`,
                  { method: "POST" },
                ),
              ]);
              const playersById = new Map(playerRows.map((p) => [p.id, p]));
              setDrawVersionId(res.drawVersionId);
              setPreview({
                drawVersionId: res.drawVersionId,
                boxes: res.boxes,
                playersById,
                status: "draft",
              });
              onLog(
                "Draft draw is shown below. Approve when you are happy with the boxes.",
              );
            } catch (e) {
              setPreview(null);
              onLog(String(e));
            }
          }}
        >
          Suggest draw
        </button>
        <input
          placeholder="drawVersionId"
          value={drawVersionId}
          onChange={(e) => setDrawVersionId(e.target.value)}
          size={40}
        />
        <button
          type="button"
          className="secondary"
          disabled={!seasonId || !drawVersionId}
          onClick={async () => {
            try {
              const res = await api<
                { ok: true; boxes: DrawBox[] } | { error: string }
              >(`/api/seasons/${seasonId}/draw/approve`, {
                method: "POST",
                body: JSON.stringify({ drawVersionId }),
              });
              if ("error" in res) {
                onLog(`Approve failed: ${res.error}`);
                return;
              }
              let playersById = preview?.playersById;
              if (
                !playersById?.size ||
                preview?.drawVersionId !== drawVersionId
              ) {
                const playerRows = await api<PlayerRow[]>("/api/players");
                playersById = new Map(playerRows.map((p) => [p.id, p]));
              }
              setPreview({
                drawVersionId,
                boxes: res.boxes,
                playersById,
                status: "approved",
              });
              onLog("Draw approved and saved to the season.");
            } catch (e) {
              onLog(String(e));
            }
          }}
        >
          Approve draw
        </button>
      </div>
      {preview && <DrawPreviewCard preview={preview} />}
    </div>
  );
}

function Weekly({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  const [week, setWeek] = useState(1);
  const [weekPlanPreview, setWeekPlanPreview] =
    useState<WeekPlanPreviewState | null>(null);
  const [emailStageInfo, setEmailStageInfo] = useState<{
    week: number;
    ids: string[];
  } | null>(null);

  useEffect(() => {
    setWeekPlanPreview(null);
    setEmailStageInfo(null);
  }, [week]);

  return (
    <div>
      <h1>Weekly matchups</h1>
      <div className="card row">
        <label>
          Week{" "}
          <input
            type="number"
            min={1}
            max={9}
            value={week}
            onChange={(e) => setWeek(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={!seasonId}
          onClick={async () => {
            try {
              const [playerRows, res] = await Promise.all([
                api<PlayerRow[]>("/api/players"),
                api<{
                  weekPlanId: string;
                  payload: { week: number; boxes: WeeklyBoxPayload[] };
                }>(`/api/seasons/${seasonId}/weeks/${week}/generate`, {
                  method: "POST",
                }),
              ]);
              const playersById = new Map(playerRows.map((p) => [p.id, p]));
              setWeekPlanPreview({
                weekPlanId: res.weekPlanId,
                week: res.payload.week,
                boxes: res.payload.boxes,
                playersById,
              });
              setEmailStageInfo(null);
              onLog(
                "Week plan is shown below. Use “Stage self-managed emails” when ready.",
              );
            } catch (e) {
              setWeekPlanPreview(null);
              onLog(String(e));
            }
          }}
        >
          Generate week plan
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!seasonId}
          onClick={async () => {
            try {
              const res = await api<
                { created: string[] } | { error: string }
              >(`/api/seasons/${seasonId}/weeks/${week}/email-self-managed`, {
                method: "POST",
              });
              if ("error" in res) {
                setEmailStageInfo(null);
                onLog(`Could not stage emails: ${res.error}`);
                return;
              }
              setEmailStageInfo({ week, ids: res.created });
              onLog(
                res.created.length
                  ? `Staged ${res.created.length} draft email(s). Details below.`
                  : "No email drafts were created for this week.",
              );
            } catch (e) {
              setEmailStageInfo(null);
              onLog(String(e));
            }
          }}
        >
          Stage self-managed emails
        </button>
      </div>
      {weekPlanPreview && weekPlanPreview.week === week ? (
        <WeeklyPlanPreviewCard {...weekPlanPreview} />
      ) : null}
      {emailStageInfo && emailStageInfo.week === week ? (
        <WeeklyEmailStageCard week={emailStageInfo.week} ids={emailStageInfo.ids} />
      ) : null}
    </div>
  );
}

type EmailTemplateRow = {
  id: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  createdAt: string;
  updatedAt: string;
};

function Emails({
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  const [subTab, setSubTab] = useState<"outbox" | "templates">("outbox");
  const [templates, setTemplates] = useState<EmailTemplateRow[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [createMode, setCreateMode] = useState(false);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const rows = await api<EmailTemplateRow[]>("/api/email-templates");
      setTemplates(rows);
    } catch (e) {
      onLog(String(e));
    } finally {
      setTemplatesLoading(false);
    }
  }, [onLog]);

  useEffect(() => {
    if (subTab !== "templates") return;
    void loadTemplates();
  }, [subTab, loadTemplates]);

  const samplePreviewVars = {
    playerName: "Alex Player",
    playerName2: "Taylor Team",
    playerName3: "Jordan Roe",
    playerName4: "Pat Partner",
    date: "2099-04-29",
    championshipName: "Singles B Championship",
    matchupBracket: "J. Doe vs Q. Roe",
    matchupFull: "Jordan Doe vs Quinn Roe",
    matchDueDate: "2099-05-01",
    matchRound: "Quarterfinal (round of 8)",
  };

  const previewSubject = interpolateEmailTemplate(
    templateSubject || " ",
    samplePreviewVars,
  ).trim();
  const previewBody = interpolateEmailTemplate(
    templateBody || " ",
    samplePreviewVars,
  ).trim();

  function applyTemplateRow(row: EmailTemplateRow | null) {
    if (!row) {
      setTemplateName("");
      setTemplateSubject("");
      setTemplateBody("");
      return;
    }
    setTemplateName(row.name);
    setTemplateSubject(row.subjectTemplate);
    setTemplateBody(row.bodyTemplate);
  }

  function onPickTemplate(id: string) {
    setSelectedTemplateId(id);
    setCreateMode(false);
    const row = templates.find((t) => t.id === id) ?? null;
    applyTemplateRow(row);
  }

  function startNewTemplate() {
    setCreateMode(true);
    setSelectedTemplateId("");
    setTemplateName("New template");
    setTemplateSubject(`[Test] {{championshipName}} — {{date}}`);
    setTemplateBody(
      `Hi {{playerName}},\n\n` +
        `This is a test message for {{championshipName}}.\n` +
        `Matchup: {{matchupFull}}\n` +
        `Due: {{matchDueDate}}\n`,
    );
  }

  return (
    <div>
      <h1>Emails</h1>

      <div
        className="row"
        style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}
        role="tablist"
        aria-label="Email pages"
      >
        <button
          type="button"
          className={subTab === "outbox" ? "primary" : "secondary"}
          onClick={() => setSubTab("outbox")}
          role="tab"
          aria-selected={subTab === "outbox"}
        >
          Email outbox
        </button>
        <button
          type="button"
          className={subTab === "templates" ? "primary" : "secondary"}
          onClick={() => setSubTab("templates")}
          role="tab"
          aria-selected={subTab === "templates"}
        >
          Email templates
        </button>
      </div>

      {subTab === "outbox" ? (
        <>
          <div className="card row">
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                const rows = await api<unknown[]>("/api/email-outbox");
                onLog(JSON.stringify(rows, null, 2));
              }}
            >
              Load outbox
            </button>
          </div>
          <p className="card">
            Approve and send by ID via API for now, e.g.{" "}
            <code>POST /api/email-outbox/:id/approve</code> then{" "}
            <code>/send</code>.
          </p>
        </>
      ) : (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Type <kbd>{"{{"}</kbd> or a single <kbd>{"{"}</kbd> to open variable
            suggestions; while the name is unfinished, the list filters as you
            type. Use ↑↓ and Enter, or click a row. The server fills{" "}
            <code>{"{{playerName}}"}</code> and <code>{"{{date}}"}</code> per
            recipient on send; the Championships test dialog can supply matchup
            fields.
          </p>

          <div
            className="row"
            style={{ flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}
          >
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              Template{" "}
              <select
                value={createMode ? "" : selectedTemplateId}
                disabled={templatesLoading}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  onPickTemplate(id);
                }}
              >
                <option value="">— Select a template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={templatesLoading}
              onClick={() => void loadTemplates()}
            >
              Refresh list
            </button>
            <button
              type="button"
              className="primary"
              disabled={templatesLoading}
              onClick={startNewTemplate}
            >
              Create new template
            </button>
            {selectedTemplateId && !createMode ? (
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  if (
                    !confirm(
                      `Delete template "${templateName}"? This cannot be undone.`,
                    )
                  )
                    return;
                  try {
                    await api(`/api/email-templates/${selectedTemplateId}`, {
                      method: "DELETE",
                    });
                    setSelectedTemplateId("");
                    applyTemplateRow(null);
                    await loadTemplates();
                    onLog("Template deleted.");
                  } catch (e) {
                    onLog(String(e));
                  }
                }}
              >
                Delete
              </button>
            ) : null}
          </div>

          <div className="card" style={{ marginTop: "1rem", background: "#f8f9fa" }}>
            <h4 style={{ marginTop: 0 }}>Common variables</h4>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS.map((v) => (
                <li key={v.key}>
                  <code>{"{{" + v.key + "}}"}</code> — {v.description}
                </li>
              ))}
            </ul>
          </div>

          {createMode || selectedTemplateId ? (
            <form
              style={{ marginTop: "1rem" }}
              onSubmit={async (ev) => {
                ev.preventDefault();
                const name = templateName.trim();
                if (!name) {
                  onLog("Enter a template name.");
                  return;
                }
                try {
                  if (createMode) {
                    const created = await api<EmailTemplateRow>(
                      "/api/email-templates",
                      {
                        method: "POST",
                        body: JSON.stringify({
                          name,
                          subjectTemplate: templateSubject,
                          bodyTemplate: templateBody,
                        }),
                      },
                    );
                    setCreateMode(false);
                    setTemplates((cur) =>
                      [...cur.filter((x) => x.id !== created.id), created].sort(
                        (a, b) => a.name.localeCompare(b.name),
                      ),
                    );
                    setSelectedTemplateId(created.id);
                    applyTemplateRow(created);
                    onLog("Template created.");
                  } else if (selectedTemplateId) {
                    const updated = await api<EmailTemplateRow>(
                      `/api/email-templates/${selectedTemplateId}`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          name,
                          subjectTemplate: templateSubject,
                          bodyTemplate: templateBody,
                        }),
                      },
                    );
                    setTemplates((cur) =>
                      cur
                        .map((x) => (x.id === updated.id ? updated : x))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                    );
                    applyTemplateRow(updated);
                    onLog("Template saved.");
                  }
                } catch (e) {
                  onLog(String(e));
                }
              }}
            >
              <label className="champ-test-email-field" style={{ display: "block", marginBottom: "0.75rem" }}>
                <span>Name</span>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  required
                  autoComplete="off"
                  disabled={templatesLoading}
                />
              </label>
              <label className="champ-test-email-field" style={{ display: "block", marginBottom: "0.75rem" }}>
                <span>Subject template</span>
                <EmailTemplateAutocompleteField
                  autocompleteIdentityKey={`${String(createMode)}:${selectedTemplateId}`}
                  value={templateSubject}
                  onChange={setTemplateSubject}
                  disabled={templatesLoading}
                />
              </label>
              <label className="champ-test-email-field" style={{ display: "block", marginBottom: "0.75rem" }}>
                <span>Body template</span>
                <EmailTemplateAutocompleteField
                  multiline
                  rows={12}
                  autocompleteIdentityKey={`${String(createMode)}:${selectedTemplateId}`}
                  value={templateBody}
                  onChange={setTemplateBody}
                  disabled={templatesLoading}
                />
              </label>

              <div
                className="card"
                style={{ marginBottom: "1rem", background: "#fff" }}
              >
                <h4 style={{ marginTop: 0 }}>Preview (sample data)</h4>
                <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>
                  Subject:{" "}
                  <span style={{ fontWeight: 400 }}>{previewSubject}</span>
                </p>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                  }}
                >
                  {previewBody}
                </pre>
              </div>

              <div className="row">
                <button type="submit" className="primary" disabled={templatesLoading}>
                  {createMode ? "Save new template" : "Save changes"}
                </button>
                {createMode ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setCreateMode(false);
                      applyTemplateRow(null);
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="card" style={{ marginTop: "1rem", marginBottom: 0 }}>
              Select an existing template to edit or create a new one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Playoffs({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  return (
    <div>
      <h1>Playoffs preview</h1>
      <div className="card row">
        <button
          type="button"
          className="primary"
          disabled={!seasonId}
          onClick={async () => {
            const res = await api<unknown>(
              `/api/seasons/${seasonId}/playoffs/preview`,
              { method: "POST" },
            );
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Preview brackets from box stats
        </button>
      </div>
    </div>
  );
}

function Phase2({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  return (
    <div>
      <h1>Phase 2 stubs</h1>
      <div className="card row">
        <button
          type="button"
          className="secondary"
          disabled={!seasonId}
          onClick={async () => {
            const res = await api<unknown>("/api/phase2/booking-proposals", {
              method: "POST",
              body: JSON.stringify({
                seasonId,
                weekNumber: 1,
                payload: {
                  weekNumber: 1,
                  assignments: [
                    {
                      boxNumber: 1,
                      match: [1, 2],
                      court: 1,
                      slotLabel: "Mon4:30",
                    },
                  ],
                },
              }),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Create booking proposal (stub)
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!seasonId}
          onClick={async () => {
            const res = await api<unknown>("/api/phase2/rating-adjustments", {
              method: "POST",
              body: JSON.stringify([
                { playerId: "x", suggestedDelta: 0.05, reason: "final win" },
              ]),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Try rating write-back (stub)
        </button>
      </div>
    </div>
  );
}
