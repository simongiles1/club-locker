import { useCallback, useEffect, useState } from "react";
import {
  EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS,
  interpolateEmailTemplate,
  type EmailTemplateScope,
} from "@squash/shared";
import { api } from "./api.js";
import { EmailTemplateAutocompleteField } from "./EmailTemplateAutocompleteField.js";

type EmailTemplateRow = {
  id: string;
  name: string;
  scope: EmailTemplateScope;
  subjectTemplate: string;
  bodyTemplate: string;
  createdAt: string;
  updatedAt: string;
};

type HlReminderSettings = {
  enabled: boolean;
  daysBefore: number;
  templateId: string | null;
};

type PlayerApiRow = {
  id: string;
  displayName: string;
  email: string | null;
};

export function EmailsPage({
  onLog,
  templateScope,
  showPageHeading = true,
}: {
  onLog: (s: string) => void;
  templateScope: EmailTemplateScope;
  showPageHeading?: boolean;
}) {
  const showScheduleTab = templateScope === "house_league";
  const [subTab, setSubTab] = useState<"outbox" | "templates" | "schedule">(
    "outbox",
  );
  const [templates, setTemplates] = useState<EmailTemplateRow[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [createMode, setCreateMode] = useState(false);

  const [hlForm, setHlForm] = useState<HlReminderSettings>({
    enabled: false,
    daysBefore: 3,
    templateId: null,
  });
  const [hlLoaded, setHlLoaded] = useState(false);
  const [hlSaving, setHlSaving] = useState(false);

  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testTemplateId, setTestTemplateId] = useState("");
  const [testToEmail, setTestToEmail] = useState("");
  const [testPlayerId, setTestPlayerId] = useState("");
  const [testDelayN, setTestDelayN] = useState("15");
  const [testDelayUnit, setTestDelayUnit] = useState<"minutes" | "hours">(
    "minutes",
  );
  const [testVarMatchDate, setTestVarMatchDate] = useState("");
  const [testVarOpponent, setTestVarOpponent] = useState("");
  const [testVarSlot, setTestVarSlot] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [clubPlayers, setClubPlayers] = useState<PlayerApiRow[]>([]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const rows = await api<EmailTemplateRow[]>(
        `/api/email-templates?scope=${encodeURIComponent(templateScope)}`,
      );
      setTemplates(rows);
    } catch (e) {
      onLog(String(e));
    } finally {
      setTemplatesLoading(false);
    }
  }, [onLog, templateScope]);

  const loadHlSettings = useCallback(async () => {
    try {
      const row = await api<HlReminderSettings>(
        "/api/house-league/email-reminders",
      );
      setHlForm(row);
      setHlLoaded(true);
    } catch (e) {
      onLog(String(e));
    }
  }, [onLog]);

  useEffect(() => {
    if (subTab !== "templates") return;
    void loadTemplates();
  }, [subTab, loadTemplates]);

  useEffect(() => {
    if (!(subTab === "schedule" && showScheduleTab)) return;
    void loadHlSettings();
    void loadTemplates();
  }, [subTab, showScheduleTab, loadHlSettings, loadTemplates]);

  useEffect(() => {
    if (!testModalOpen) return;
    let cancelled = false;
    api<PlayerApiRow[]>("/api/players")
      .then((rows) => {
        if (!cancelled) setClubPlayers(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [testModalOpen]);

  useEffect(() => {
    if (!testModalOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setTestModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [testModalOpen]);

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
    matchDate: "2099-05-10",
    matchSlot: "18:45-19:30",
    matchTimeSlot: "18:45-19:30",
    opponentName: "Taylor Team",
    boxNumber: "3",
    weekNumber: "2",
    courtLabel: "Court 1",
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
    if (templateScope === "house_league") {
      setTemplateSubject(`Reminder: match on {{matchDate}} ({{matchSlot}})`);
      setTemplateBody(
        `Hi {{playerName}},\n\n` +
          `This is a reminder for your house league match vs {{opponentName}} on {{matchDate}} at {{matchSlot}} ({{courtLabel}}, box {{boxNumber}}, week {{weekNumber}}).\n\n` +
          `Thanks,\n`,
      );
    } else {
      setTemplateSubject(`[Test] {{championshipName}} — {{date}}`);
      setTemplateBody(
        `Hi {{playerName}},\n\n` +
          `This is a test message for {{championshipName}}.\n` +
          `Matchup: {{matchupFull}}\n` +
          `Due: {{matchDueDate}}\n`,
      );
    }
  }

  function openTestModal() {
    setTestTemplateId(
      hlForm.templateId ?? templates[0]?.id ?? selectedTemplateId ?? "",
    );
    setTestToEmail("");
    setTestPlayerId("");
    setTestDelayN("15");
    setTestDelayUnit("minutes");
    setTestVarMatchDate("");
    setTestVarOpponent("");
    setTestVarSlot("");
    setTestModalOpen(true);
  }

  async function saveHlSchedule() {
    setHlSaving(true);
    try {
      const updated = await api<HlReminderSettings>(
        "/api/house-league/email-reminders",
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: hlForm.enabled,
            daysBefore: hlForm.daysBefore,
            templateId: hlForm.templateId,
          }),
        },
      );
      setHlForm(updated);
      onLog("Reminder schedule saved.");
    } catch (e) {
      onLog(String(e));
    } finally {
      setHlSaving(false);
    }
  }

  async function submitTestReminder() {
    const n = Number.parseInt(testDelayN, 10);
    if (!Number.isFinite(n) || n < 1) {
      onLog("Enter a positive delay amount.");
      return;
    }
    if (testDelayUnit === "minutes" && n > 7 * 24 * 60) {
      onLog("Delay too long (max 7 days).");
      return;
    }
    if (testDelayUnit === "hours" && n > 168) {
      onLog("Delay too long (max 168 hours).");
      return;
    }
    const tid = testTemplateId.trim();
    if (!tid) {
      onLog("Choose a template.");
      return;
    }
    const vars: Record<string, string> = {};
    if (testVarMatchDate.trim()) vars.matchDate = testVarMatchDate.trim();
    if (testVarOpponent.trim()) vars.opponentName = testVarOpponent.trim();
    if (testVarSlot.trim()) {
      vars.matchSlot = testVarSlot.trim();
      vars.matchTimeSlot = testVarSlot.trim();
    }
    setTestSending(true);
    try {
      const body = {
        templateId: tid,
        toEmail: testToEmail.trim() || undefined,
        playerId: testPlayerId.trim() || undefined,
        delayMinutes:
          testDelayUnit === "minutes" ? n : undefined,
        delayHours: testDelayUnit === "hours" ? n : undefined,
        vars: Object.keys(vars).length > 0 ? vars : undefined,
      };
      const res = await api<{ ok: boolean; scheduledSendAt: string }>(
        "/api/house-league/email-reminders/test-send",
        { method: "POST", body: JSON.stringify(body) },
      );
      onLog(
        `Queued test reminder; scheduled_send_at=${res.scheduledSendAt} (depends on scheduler tick).`,
      );
      setTestModalOpen(false);
    } catch (e) {
      onLog(String(e));
    } finally {
      setTestSending(false);
    }
  }

  return (
    <div>
      {showPageHeading ? <h1>Emails</h1> : null}

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
        {showScheduleTab ? (
          <button
            type="button"
            className={subTab === "schedule" ? "primary" : "secondary"}
            onClick={() => setSubTab("schedule")}
            role="tab"
            aria-selected={subTab === "schedule"}
          >
            Schedule
          </button>
        ) : null}
      </div>

      {subTab === "schedule" && showScheduleTab ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            After bulk bookings are converted to individual Club Locker reservations,
            players no longer receive spaced booking confirmations from Club Locker.
            Enable reminders so each roster player gets an email a few days before
            their booked match time. Sends use the automation scheduler interval and{" "}
            <code>email_outbox</code>.
          </p>
          {!hlLoaded ? (
            <p>Loading…</p>
          ) : (
            <>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.75rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={hlForm.enabled}
                  onChange={(e) =>
                    setHlForm((f) => ({ ...f, enabled: e.target.checked }))
                  }
                />
                Enable weekly match reminders
              </label>

              <label
                style={{ display: "block", marginBottom: "0.75rem", maxWidth: "16rem" }}
              >
                <span>Days before match</span>
                <input
                  type="number"
                  min={0}
                  max={14}
                  value={hlForm.daysBefore}
                  onChange={(e) =>
                    setHlForm((f) => ({
                      ...f,
                      daysBefore: Number.parseInt(e.target.value || "3", 10) || 0,
                    }))
                  }
                />
              </label>

              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span>Reminder template</span>
                <select
                  value={hlForm.templateId ?? ""}
                  onChange={(e) =>
                    setHlForm((f) => ({
                      ...f,
                      templateId: e.target.value === "" ? null : e.target.value,
                    }))
                  }
                  disabled={templatesLoading}
                >
                  <option value="">— None —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="row" style={{ gap: "0.75rem", marginBottom: "1rem" }}>
                <button
                  type="button"
                  className="primary"
                  disabled={hlSaving}
                  onClick={() => void saveHlSchedule()}
                >
                  Save schedule
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={templatesLoading || !templates.length}
                  onClick={() => openTestModal()}
                >
                  Send test…
                </button>
              </div>

              <p style={{ margin: 0 }} className="champ-help-small">
                <strong>Test send:</strong> queues a message as{" "}
                <code>status=scheduled</code> on the server; delivery runs on the next
                automation tick after <code>scheduled_send_at</code> (
                virtual clock applies when automation test mode is on).
              </p>
            </>
          )}
        </div>
      ) : null}

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
      ) : subTab === "templates" ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Type <kbd>{"{{"}</kbd> or a single <kbd>{"{"}</kbd> to open variable
            suggestions; while the name is unfinished, the list filters as you type.
            Use ↑↓ and Enter, or click a row. The server fills{" "}
            <code>{"{{playerName}}"}</code> and <code>{"{{date}}"}</code> per recipient
            on send; scheduled house league reminders also fill{" "}
            <code>matchDate</code>, <code>opponentName</code>,{" "}
            <code>matchSlot</code>, etc.
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
                          scope: templateScope,
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
      ) : null}

      {testModalOpen ? (
        <div
          className="champ-test-email-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setTestModalOpen(false);
          }}
        >
          <div
            className="champ-test-email-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hl-reminder-test-title"
          >
            <h3 id="hl-reminder-test-title">Schedule test reminder</h3>
            <p className="champ-help-small" style={{ marginTop: 0 }}>
              Queues mail to outbox (<code>house_league_reminder_test</code>) for delayed
              send.
            </p>

            <div className="champ-test-email-field">
              <label htmlFor="hl-test-template">Template</label>
              <select
                id="hl-test-template"
                value={testTemplateId}
                onChange={(e) => setTestTemplateId(e.target.value)}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="champ-test-email-field">
              <label htmlFor="hl-test-email">To email (optional if player chosen)</label>
              <input
                id="hl-test-email"
                type="email"
                autoComplete="email"
                value={testToEmail}
                onChange={(e) => setTestToEmail(e.target.value)}
              />
            </div>

            <div className="champ-test-email-field">
              <label htmlFor="hl-test-player">From roster (optional)</label>
              <select
                id="hl-test-player"
                value={testPlayerId}
                onChange={(e) => setTestPlayerId(e.target.value)}
              >
                <option value="">— None —</option>
                {clubPlayers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.email ? ` (${p.email})` : " — no email"}
                  </option>
                ))}
              </select>
            </div>

            <div
              className="row champ-test-email-field"
              style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "0.5rem" }}
            >
              <label style={{ flex: "1", minWidth: "6rem" }}>
                Delay amount
                <input
                  type="number"
                  min={1}
                  value={testDelayN}
                  onChange={(e) => setTestDelayN(e.target.value)}
                />
              </label>
              <label>
                Unit
                <select
                  value={testDelayUnit}
                  onChange={(e) =>
                    setTestDelayUnit(e.target.value as "minutes" | "hours")
                  }
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
              </label>
            </div>

            <details style={{ marginBottom: "1rem" }}>
              <summary>Substitution overrides (optional)</summary>
              <div className="champ-test-email-field">
                <label htmlFor="hl-test-vdate">matchDate</label>
                <input
                  id="hl-test-vdate"
                  type="text"
                  placeholder="2099-05-01"
                  value={testVarMatchDate}
                  onChange={(e) => setTestVarMatchDate(e.target.value)}
                />
              </div>
              <div className="champ-test-email-field">
                <label htmlFor="hl-test-vopp">opponentName</label>
                <input
                  id="hl-test-vopp"
                  type="text"
                  value={testVarOpponent}
                  onChange={(e) => setTestVarOpponent(e.target.value)}
                />
              </div>
              <div className="champ-test-email-field">
                <label htmlFor="hl-test-vslot">matchSlot</label>
                <input
                  id="hl-test-vslot"
                  type="text"
                  placeholder="18:45-19:30"
                  value={testVarSlot}
                  onChange={(e) => setTestVarSlot(e.target.value)}
                />
              </div>
            </details>

            <div className="row" style={{ justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                className="secondary"
                disabled={testSending}
                onClick={() => setTestModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={testSending}
                onClick={() => void submitTestReminder()}
              >
                {testSending ? "Queueing…" : "Queue email"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
