import { useCallback, useEffect, useMemo, useState } from "react";
import type { StatHoliday } from "@squash/shared";
import { api } from "./api.js";
import { useToast } from "./toast.js";

type StatutoryHolidayApiRow = {
  id: string;
  name: string;
  date: string;
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
    hours: {
      open: row.hours.open,
      close: row.hours.close,
      closed: row.hours.closed,
    },
  };
}

export function StatutoryHolidaysPage() {
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<StatutoryHolidayApiRow[]>("/api/statutory-holidays");
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

  const addHoliday = useCallback(async () => {
    const name = newName.trim();
    const date = newDate.trim();
    if (!name || !date) {
      show("Enter a name and date.");
      return;
    }
    setSaving(true);
    try {
      await api("/api/statutory-holidays", {
        method: "POST",
        body: JSON.stringify({
          name,
          date,
          closed: newClosed,
          open: newClosed ? null : newOpen,
          close: newClosed ? null : newClose,
        }),
      });
      setNewName("");
      setNewDate("");
      setNewClosed(false);
      setNewOpen("08:00");
      setNewClose("18:00");
      await load();
      show("Holiday added.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      show(msg);
    } finally {
      setSaving(false);
    }
  }, [newName, newDate, newClosed, newOpen, newClose, load, show]);

  const removeHoliday = useCallback(
    async (id: string, label: string) => {
      if (!window.confirm(`Remove “${label}” from statutory holidays?`)) return;
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

  return (
    <div
      className="statutory-holidays-page"
      id="panel-houseleague-statutory"
      role="tabpanel"
      aria-labelledby="tab-houseleague-statutory"
    >
      <p className="houseleague-lead houseleague-lead--page">
        Statutory and special closure days drive the court-booking calendar (Monday shifts, early
        close blocks). Defaults are seeded for several club years; edit the list below anytime.
      </p>

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
      </div>

      {loadError ? (
        <div className="houseleague-banner houseleague-banner--error" role="alert">
          <strong>Could not load holidays.</strong> {loadError}
        </div>
      ) : null}

      <div className="card statutory-holidays-add">
        <h2 className="statutory-holidays-add-title">Add a holiday</h2>
        <div className="statutory-holidays-add-grid">
          <label className="statutory-holidays-field">
            <span>Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Civic Holiday"
              autoComplete="off"
            />
          </label>
          <label className="statutory-holidays-field">
            <span>Date</span>
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </label>
          <label className="statutory-holidays-field statutory-holidays-field--check">
            <input
              type="checkbox"
              checked={newClosed}
              onChange={(e) => setNewClosed(e.target.checked)}
            />
            <span>Fully closed</span>
          </label>
          {!newClosed ? (
            <>
              <label className="statutory-holidays-field">
                <span>Open</span>
                <input type="time" value={newOpen} onChange={(e) => setNewOpen(e.target.value)} />
              </label>
              <label className="statutory-holidays-field">
                <span>Close</span>
                <input type="time" value={newClose} onChange={(e) => setNewClose(e.target.value)} />
              </label>
            </>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            disabled={saving}
            onClick={() => void addHoliday()}
          >
            {saving ? "Saving…" : "Add holiday"}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="statutory-holidays-list-title">
          {year} holidays
          {loading ? " (loading…)" : ""}
        </h2>
        {filtered.length === 0 && !loading ? (
          <p className="houseleague-status houseleague-status--muted">
            No holidays for {year}. Add one above or pick another year.
          </p>
        ) : (
          <div className="houseleague-table-wrap">
            <table className="houseleague-table statutory-holidays-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Name</th>
                  <th scope="col">Hours</th>
                  <th scope="col" className="statutory-holidays-col-action">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const st = apiRowToStatHoliday(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <time dateTime={r.date}>{r.date}</time>
                      </td>
                      <td>{r.name}</td>
                      <td>{formatHoursLabel(st.hours)}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary statutory-holidays-remove"
                          onClick={() => void removeHoliday(r.id, r.name)}
                        >
                          Remove
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
    </div>
  );
}
