import { useCallback, useEffect, useState } from "react";
import {
  EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS,
  interpolateEmailTemplate,
} from "@squash/shared";
import { api } from "./api.js";
import { EmailTemplateAutocompleteField } from "./EmailTemplateAutocompleteField.js";

type EmailTemplateRow = {
  id: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  createdAt: string;
  updatedAt: string;
};

export function EmailsPage({ onLog }: { onLog: (s: string) => void }) {
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
