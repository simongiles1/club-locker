import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { useToast } from "./toast.js";

export type FeedbackTicketRow = {
  id: string;
  kind: "bug" | "feature";
  description: string;
  screenshot: { mime: string; base64: string } | null;
  completedAt: string | null;
  createdAt: string;
};

function readFileAsImagePayload(file: File): Promise<{
  mime: string;
  base64: string;
  previewUrl: string;
}> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file (PNG, JPEG, GIF, or WebP)."));
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const m = s.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) {
        reject(new Error("Could not read image."));
        return;
      }
      resolve({
        mime: m[1],
        base64: m[2].replace(/\s/g, ""),
        previewUrl: s,
      });
    };
    r.onerror = () => reject(r.error ?? new Error("Could not read file."));
    r.readAsDataURL(file);
  });
}

function kindLabel(kind: FeedbackTicketRow["kind"]): string {
  return kind === "bug" ? "Bug" : "Feature";
}

export function FeedbackPage() {
  const { show } = useToast();
  const [rows, setRows] = useState<FeedbackTicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalKind, setModalKind] = useState<FeedbackTicketRow["kind"] | null>(null);
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<{
    mime: string;
    base64: string;
    previewUrl: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<FeedbackTicketRow[]>("/api/feedback-tickets");
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openModal = (kind: FeedbackTicketRow["kind"]) => {
    setModalKind(kind);
    setDescription("");
    setScreenshot(null);
  };

  const closeModal = () => {
    setModalKind(null);
    setDescription("");
    setScreenshot(null);
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const p = await readFileAsImagePayload(file);
      setScreenshot(p);
    } catch (err) {
      show(err instanceof Error ? err.message : String(err));
    }
  };

  const applyClipboardImageFile = useCallback(
    (file: File | null | undefined) => {
      if (!file || !file.type.startsWith("image/")) return false;
      void readFileAsImagePayload(file).then(setScreenshot).catch((err) => {
        show(err instanceof Error ? err.message : String(err));
      });
      return true;
    },
    [show],
  );

  /** Paste event: handles Snipping Tool, Win+Shift+S, browser copy-image, etc. */
  const onPasteInModal = (e: React.ClipboardEvent) => {
    const cd = e.clipboardData;
    if (!cd) return;

    const files = cd.files;
    if (files?.length) {
      for (let i = 0; i < files.length; i++) {
        const f = files.item(i);
        if (f && f.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          if (applyClipboardImageFile(f)) return;
        }
      }
    }

    const items = cd.items;
    if (!items?.length) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item?.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        e.stopPropagation();
        if (applyClipboardImageFile(file)) return;
      }
    }
  };

  /** Button path: works when the keyboard paste event doesn’t expose files (some browsers). */
  const pasteFromClipboardApi = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
      show("Use Ctrl+V (or Cmd+V) while this window is focused, or upload a file.");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const clipItem of items) {
        for (const type of clipItem.types) {
          if (!type.startsWith("image/")) continue;
          const blob = await clipItem.getType(type);
          const ext =
            type === "image/png"
              ? "png"
              : type === "image/jpeg" || type === "image/jpg"
                ? "jpg"
                : type === "image/gif"
                  ? "gif"
                  : type === "image/webp"
                    ? "webp"
                    : "png";
          const file = new File([blob], `clipboard.${ext}`, { type });
          if (applyClipboardImageFile(file)) return;
        }
      }
      show("No image on the clipboard. Copy a screenshot first (e.g. Win+Shift+S, then paste).");
    } catch {
      show(
        "Could not read the clipboard (permission denied?). Use Ctrl+V in this dialog or upload a file.",
      );
    }
  }, [applyClipboardImageFile, show]);

  const deleteTicket = useCallback(
    async (row: FeedbackTicketRow) => {
      const kind = kindLabel(row.kind).toLowerCase();
      if (
        !window.confirm(
          `Delete this ${kind} ticket? This cannot be undone.`,
        )
      ) {
        return;
      }
      setRowBusyId(row.id);
      try {
        await api<{ ok: true }>(`/api/feedback-tickets/${row.id}`, {
          method: "DELETE",
        });
        await load();
        show("Deleted.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        show(msg);
      } finally {
        setRowBusyId(null);
      }
    },
    [load, show],
  );

  const setTicketCompleted = useCallback(
    async (row: FeedbackTicketRow, completed: boolean) => {
      setRowBusyId(row.id);
      try {
        await api<FeedbackTicketRow>(`/api/feedback-tickets/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ completed }),
        });
        await load();
        show(completed ? "Marked complete." : "Reopened.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        show(msg);
      } finally {
        setRowBusyId(null);
      }
    },
    [load, show],
  );

  const submit = async () => {
    if (modalKind == null) return;
    const d = description.trim();
    if (!d) {
      show("Enter a description.");
      return;
    }
    setSaving(true);
    try {
      await api("/api/feedback-tickets", {
        method: "POST",
        body: JSON.stringify({
          kind: modalKind,
          description: d,
          screenshotMime: screenshot?.mime ?? null,
          screenshotBase64: screenshot?.base64 ?? null,
        }),
      });
      closeModal();
      await load();
      show("Saved.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      show(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="feedback-page">
      <p className="houseleague-lead houseleague-lead--page">
        Track bugs and feature ideas in one place. Optional screenshots attach to each item.
      </p>

      <div className="card feedback-toolbar">
        <button type="button" className="primary" onClick={() => openModal("bug")}>
          Add bug
        </button>
        <button type="button" className="primary" onClick={() => openModal("feature")}>
          Add feature
        </button>
      </div>

      {loadError ? (
        <div className="houseleague-banner houseleague-banner--error" role="alert">
          <strong>Could not load tickets.</strong> {loadError}
        </div>
      ) : null}

      <div className="card">
        <h2 className="feedback-list-title">
          Tickets
          {loading ? " (loading…)" : ""}
        </h2>
        {rows.length === 0 && !loading ? (
          <p className="houseleague-status houseleague-status--muted">
            No tickets yet. Use the buttons above to add a bug or feature.
          </p>
        ) : (
          <div className="houseleague-table-wrap">
            <table className="houseleague-table feedback-table">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Description</th>
                  <th scope="col">Screenshot</th>
                  <th scope="col">Added</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="feedback-col-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isComplete = Boolean(r.completedAt);
                  const busy = rowBusyId === r.id;
                  return (
                    <tr key={r.id} className={isComplete ? "feedback-row--complete" : undefined}>
                      <td>
                        <span
                          className={
                            r.kind === "bug"
                              ? "feedback-kind feedback-kind--bug"
                              : "feedback-kind feedback-kind--feature"
                          }
                        >
                          {kindLabel(r.kind)}
                        </span>
                      </td>
                      <td className="feedback-desc-cell">
                        <div className="feedback-desc">{r.description}</div>
                      </td>
                      <td className="feedback-shot-cell">
                        {r.screenshot ? (
                          <a
                            href={`data:${r.screenshot.mime};base64,${r.screenshot.base64}`}
                            target="_blank"
                            rel="noreferrer"
                            className="feedback-shot-link"
                          >
                            <img
                              className="feedback-shot-thumb"
                              src={`data:${r.screenshot.mime};base64,${r.screenshot.base64}`}
                              alt=""
                            />
                          </a>
                        ) : (
                          <span className="houseleague-status houseleague-status--muted">—</span>
                        )}
                      </td>
                      <td>
                        <time dateTime={r.createdAt}>
                          {r.createdAt.replace("T", " ").slice(0, 19)}
                        </time>
                      </td>
                      <td>
                        {isComplete ? (
                          <span className="feedback-status feedback-status--done">Complete</span>
                        ) : (
                          <span className="feedback-status feedback-status--open">Open</span>
                        )}
                      </td>
                      <td className="feedback-actions-cell">
                        <div className="feedback-row-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void setTicketCompleted(r, !isComplete)}
                          >
                            {busy
                              ? "…"
                              : isComplete
                                ? "Reopen"
                                : "Mark complete"}
                          </button>
                          <button
                            type="button"
                            className="secondary feedback-delete-btn"
                            disabled={busy}
                            onClick={() => void deleteTicket(r)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalKind != null ? (
        <div
          className="feedback-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="feedback-modal" onPasteCapture={onPasteInModal}>
            <h3 id="feedback-modal-title">
              {modalKind === "bug" ? "New bug report" : "New feature request"}
            </h3>
            <label className="feedback-field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="What happened, or what would you like to see?"
                autoFocus
              />
            </label>
            <div className="feedback-field">
              <span>Screenshot (optional)</span>
              <div className="feedback-shot-controls">
                <div className="feedback-shot-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={saving}
                    onClick={() => void pasteFromClipboardApi()}
                  >
                    Paste from clipboard
                  </button>
                  <span className="feedback-shot-or">or</span>
                  <label className="feedback-file-pick">
                    <span className="visually-hidden">Upload image file</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      onChange={onPickFile}
                      disabled={saving}
                    />
                    <span className="feedback-file-pick-label">Choose file…</span>
                  </label>
                </div>
                <p className="feedback-paste-hint">
                  After you copy a screenshot to the clipboard (e.g. <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>),
                  use <strong>Paste from clipboard</strong> or press <kbd>Ctrl</kbd>+<kbd>V</kbd> /{" "}
                  <kbd>Cmd</kbd>+<kbd>V</kbd> anywhere in this dialog—including in the description box.
                </p>
              </div>
              {screenshot ? (
                <div className="feedback-shot-preview-wrap">
                  <img className="feedback-shot-preview" src={screenshot.previewUrl} alt="Screenshot preview" />
                  <button type="button" className="secondary" onClick={() => setScreenshot(null)}>
                    Remove image
                  </button>
                </div>
              ) : null}
            </div>
            <div className="feedback-modal-actions">
              <button type="button" className="secondary" onClick={closeModal} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
