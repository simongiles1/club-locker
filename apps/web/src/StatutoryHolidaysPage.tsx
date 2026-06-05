import { useCallback, useEffect, useMemo, useState } from "react";
import type { StatHoliday, StatHolidayKind } from "@squash/shared";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "./api.js";
import { useToast } from "./toast.js";

type StatutoryHolidayApiRow = {
  id: string;
  name: string;
  date: string;
  kind: StatHolidayKind;
  hours: {
    open: string | null;
    close: string | null;
    closed: boolean;
  };
};

function formatHoursLabel(h: StatHoliday["hours"]): string {
  if (h.closed) return "Closed";
  if (h.open && h.close) return `${h.open}–${h.close}`;
  return "—";
}

function apiRowToStatHoliday(row: StatutoryHolidayApiRow): StatHoliday {
  return {
    name: row.name,
    date: row.date,
    kind: row.kind,
    hours: {
      open: row.hours.open,
      close: row.hours.close,
      closed: row.hours.closed,
    },
  };
}

function kindLabel(kind: StatHolidayKind): string {
  return kind === "event" ? "Event" : "Holiday";
}

export function StatutoryHolidaysPage({ embedded = false }: { embedded?: boolean }) {
  const { show } = useToast();
  const [rows, setRows] = useState<StatutoryHolidayApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [saving, setSaving] = useState(false);

  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newClosed, setNewClosed] = useState(false);
  const [newOpen, setNewOpen] = useState("08:00");
  const [newClose, setNewClose] = useState("18:00");
  const [newKind, setNewKind] = useState<StatHolidayKind>("holiday");
  const [closureModalOpen, setClosureModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const resetFormFields = useCallback(() => {
    setNewName("");
    setNewDate("");
    setNewClosed(false);
    setNewOpen("08:00");
    setNewClose("18:00");
    setNewKind("holiday");
  }, []);

  const closeModal = useCallback(() => {
    setClosureModalOpen(false);
    setEditingId(null);
    resetFormFields();
  }, [resetFormFields]);

  const openAddModal = useCallback(() => {
    setEditingId(null);
    resetFormFields();
    setClosureModalOpen(true);
  }, [resetFormFields]);

  const openEditModal = useCallback(
    (r: StatutoryHolidayApiRow) => {
      resetFormFields();
      setEditingId(r.id);
      setNewName(r.name);
      setNewDate(r.date);
      setNewKind(r.kind);
      setNewClosed(r.hours.closed);
      setNewOpen(r.hours.open ?? "08:00");
      setNewClose(r.hours.close ?? "18:00");
      setClosureModalOpen(true);
    },
    [resetFormFields],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<(Omit<StatutoryHolidayApiRow, "kind"> & { kind?: StatHolidayKind })[]>(
        "/api/statutory-holidays",
      );
      setRows(
        Array.isArray(data)
          ? data.map((r) => ({
              ...r,
              kind: r.kind === "event" ? "event" : "holiday",
            }))
          : [],
      );
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

  const yearOptions = useMemo(() => {
    const cy = new Date().getFullYear();
    const out: number[] = [];
    for (let y = cy - 2; y <= cy + 3; y++) out.push(y);
    return out;
  }, []);

  const filtered = useMemo(
    () =>
      [...rows]
        .filter((r) => String(r.date).startsWith(`${year}-`))
        .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    [rows, year],
  );

  const saveClosure = useCallback(async () => {
    const name = newName.trim();
    const date = newDate.trim();
    if (!name || !date) {
      show("Enter a name and date.");
      return;
    }
    const editId = editingId;
    const payload = {
      name,
      date,
      closed: newClosed,
      open: newClosed ? null : newOpen,
      close: newClosed ? null : newClose,
      kind: newKind,
    };
    setSaving(true);
    try {
      if (editId) {
        await api(`/api/statutory-holidays/${editId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        show("Closure updated.");
      } else {
        await api("/api/statutory-holidays", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        show("Closure saved.");
      }
      await load();
      closeModal();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      show(msg);
    } finally {
      setSaving(false);
    }
  }, [
    newName,
    newDate,
    newClosed,
    newOpen,
    newClose,
    newKind,
    editingId,
    load,
    show,
    closeModal,
  ]);

  useEffect(() => {
    if (!closureModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closureModalOpen, saving, closeModal]);

  const removeHoliday = useCallback(
    async (id: string, label: string) => {
      if (!window.confirm(`Remove “${label}” from closures?`)) return;
      try {
        await api(`/api/statutory-holidays/${id}`, { method: "DELETE" });
        await load();
        show("Removed.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        show(msg);
      }
    },
    [load, show],
  );

  const modalTitle = editingId ? "Edit closure" : "Add closure";
  const modalTitleId = "statutory-holidays-closure-modal-title";

  const inner = (
    <>
      {embedded ? null : (
        <p className="houseleague-lead houseleague-lead--page">
          Statutory holidays and club events (parties, tournaments) share this list. Only{" "}
          <strong>Holiday</strong> rows shift Monday league play when they fall on a Monday;{" "}
          <strong>Event</strong> rows adjust hours on the calendar only.
        </p>
      )}

      <div className="card statutory-holidays-toolbar">
        <label>
          Calendar year{" "}
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label="Filter by calendar year"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </button>
        <button type="button" className="primary" onClick={openAddModal}>
          Add closure
        </button>
      </div>

      {loadError ? (
        <div className="houseleague-banner houseleague-banner--error" role="alert">
          <strong>Could not load holidays.</strong> {loadError}
        </div>
      ) : null}

      {closureModalOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !saving) closeModal();
          }}
        >
          <div
            className="booking-single-match-modal statutory-holidays-add-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            onMouseDown={(ev) => ev.stopPropagation()}
          >
            <h3 id={modalTitleId} style={{ marginTop: 0 }}>
              {modalTitle}
            </h3>
            <div className="statutory-holidays-modal-name-date">
              <label className="statutory-holidays-field">
                <span>Name</span>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Civic Holiday or Holiday party"
                  autoComplete="off"
                />
              </label>
              <label className="statutory-holidays-field">
                <span>Date</span>
                <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </label>
            </div>
            <div className="statutory-holidays-modal-type-check-row">
              <label className="statutory-holidays-field statutory-holidays-modal-kind">
                <span>Type</span>
                <select
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as StatHolidayKind)}
                  aria-label="Closure type"
                >
                  <option value="holiday">Holiday</option>
                  <option value="event">Event</option>
                </select>
              </label>
              <label className="statutory-holidays-field statutory-holidays-field--check statutory-holidays-field--check-modal">
                <input
                  type="checkbox"
                  checked={newClosed}
                  onChange={(e) => setNewClosed(e.target.checked)}
                />
                <span>Fully closed</span>
              </label>
            </div>
            {!newClosed ? (
              <div className="statutory-holidays-modal-hours-row">
                <label className="statutory-holidays-field">
                  <span>Open</span>
                  <input type="time" value={newOpen} onChange={(e) => setNewOpen(e.target.value)} />
                </label>
                <label className="statutory-holidays-field">
                  <span>Close</span>
                  <input
                    type="time"
                    value={newClose}
                    onChange={(e) => setNewClose(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
            <div className="booking-single-match-actions">
              <button type="button" className="secondary" disabled={saving} onClick={closeModal}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={saving} onClick={() => void saveClosure()}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Save closure"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="statutory-holidays-list-head">
          <h2 className="statutory-holidays-list-title">
            {year} closures
            {loading ? " (loading…)" : ""}
          </h2>
          {!loading && filtered.length > 0 ? (
            <div className="statutory-holidays-row-legend" role="group" aria-label="Row colours">
              <span className="statutory-holidays-legend-item statutory-holidays-legend-item--holiday">
                Holiday
              </span>
              <span className="statutory-holidays-legend-item statutory-holidays-legend-item--event">
                Event
              </span>
            </div>
          ) : null}
        </div>
        {filtered.length === 0 && !loading ? (
          <p className="houseleague-status houseleague-status--muted">
            No closures for {year}. Use Add closure or pick another year.
          </p>
        ) : (
          <div className="houseleague-table-wrap">
            <table className="houseleague-table statutory-holidays-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="statutory-holidays-col-type">
                    Type
                  </th>
                  <th scope="col">Hours</th>
                  <th scope="col" className="statutory-holidays-col-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const st = apiRowToStatHoliday(r);
                  const rowKindClass =
                    r.kind === "event"
                      ? "statutory-holidays-row--event"
                      : "statutory-holidays-row--holiday";
                  return (
                    <tr key={r.id} className={rowKindClass}>
                      <td>
                        <time dateTime={r.date}>{r.date}</time>
                      </td>
                      <td>{r.name}</td>
                      <td className="statutory-holidays-col-type statutory-holidays-type-cell">
                        {kindLabel(r.kind)}
                      </td>
                      <td>{formatHoursLabel(st.hours)}</td>
                      <td className="statutory-holidays-col-actions">
                        <button
                          type="button"
                          className="statutory-holidays-icon-btn"
                          aria-label={`Edit ${r.name}`}
                          onClick={() => openEditModal(r)}
                        >
                          <Pencil size={18} strokeWidth={2} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="statutory-holidays-icon-btn statutory-holidays-icon-btn--danger"
                          aria-label={`Remove ${r.name}`}
                          onClick={() => void removeHoliday(r.id, r.name)}
                        >
                          <Trash2 size={18} strokeWidth={2} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="statutory-holidays-page statutory-holidays-page--embedded">
        {inner}
      </div>
    );
  }

  return (
    <div
      className="statutory-holidays-page"
      id="panel-houseleague-statutory"
      role="tabpanel"
      aria-labelledby="tab-houseleague-statutory"
    >
      {inner}
    </div>
  );
}
