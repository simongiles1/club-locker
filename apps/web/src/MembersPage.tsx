import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

export type ClubMember = {
  ssmId: number;
  lastLogin: string | null;
  firstName: string;
  lastName: string;
  email: string;
  cellPhone: string | null;
  workPhone: string | null;
  homePhone: string | null;
  sex: string | null;
  profilePictureUrl: string | null;
  city: string | null;
  birthDate: string | null;
  age: number | null;
  memberType: string | null;
  customId: string | null;
  userName: string | null;
  ratingSingles: number | null;
  ratingDoubles: number | null;
  affiliatedOn: string | null;
  accountVerified: boolean | null;
};

function formatShortDate(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function primaryPhone(m: ClubMember): string {
  const parts = [m.cellPhone, m.workPhone, m.homePhone].filter(
    (x): x is string => typeof x === "string" && x.trim() !== "",
  );
  return parts[0] ?? "—";
}

function displayRating(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

function initials(first: string, last: string): string {
  const a = first.trim().charAt(0);
  const b = last.trim().charAt(0);
  const s = `${a}${b}`.toUpperCase();
  return s || "?";
}

type SortKey = "name" | "rating" | "affiliated" | "login";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

export function MembersPage() {
  const [rows, setRows] = useState<ClubMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] =
    useState<(typeof PAGE_SIZE_OPTIONS)[number]>(50);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<ClubMember[]>("/api/club-members");
      setRows(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      /* handled in load */
    });
  }, [load]);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      if (sortKey === "name") {
        const c = a.lastName.localeCompare(b.lastName, undefined, {
          sensitivity: "base",
        });
        if (c !== 0) return c * dir;
        return (
          a.firstName.localeCompare(b.firstName, undefined, {
            sensitivity: "base",
          }) * dir
        );
      }
      if (sortKey === "rating") {
        const ar = a.ratingSingles ?? -1;
        const br = b.ratingSingles ?? -1;
        if (ar !== br) return (ar - br) * dir;
        return (
          a.lastName.localeCompare(b.lastName, undefined, {
            sensitivity: "base",
          }) * dir
        );
      }
      if (sortKey === "affiliated") {
        const at = a.affiliatedOn ? new Date(a.affiliatedOn).getTime() : 0;
        const bt = b.affiliatedOn ? new Date(b.affiliatedOn).getTime() : 0;
        if (at !== bt) return (at - bt) * dir;
        return (
          a.lastName.localeCompare(b.lastName, undefined, {
            sensitivity: "base",
          }) * dir
        );
      }
      const at = a.lastLogin ? new Date(a.lastLogin).getTime() : 0;
      const bt = b.lastLogin ? new Date(b.lastLogin).getTime() : 0;
      if (at !== bt) return (at - bt) * dir;
      return (
        a.lastName.localeCompare(b.lastName, undefined, {
          sensitivity: "base",
        }) * dir
      );
    });
  }, [rows, sortKey, sortDir]);

  const pageCount = Math.max(
    1,
    Math.ceil(sortedRows.length / pageSize) || 1,
  );
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    setPage((p) => Math.min(p, pageCount));
  }, [pageCount]);

  const pageStart = (safePage - 1) * pageSize;
  const pageSlice = sortedRows.slice(pageStart, pageStart + pageSize);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div className="members-page">
      {error ? (
        <div className="members-error-inline" role="alert">
          <strong>Could not load members.</strong> {error}
        </div>
      ) : null}

      <div className="members-table-wrap">
        <table className="members-table">
          <thead>
            <tr>
              <th scope="col" className="members-col-photo">
                {" "}
              </th>
              <th scope="col">
                <button
                  type="button"
                  className="members-th-btn"
                  onClick={() => toggleSort("name")}
                >
                  Name{sortIndicator("name")}
                </button>
              </th>
              <th scope="col">Email</th>
              <th scope="col">Phone</th>
              <th scope="col">
                <button
                  type="button"
                  className="members-th-btn"
                  onClick={() => toggleSort("rating")}
                >
                  Singles{sortIndicator("rating")}
                </button>
              </th>
              <th scope="col">Doubles</th>
              <th scope="col">Type</th>
              <th scope="col">ID</th>
              <th scope="col">
                <button
                  type="button"
                  className="members-th-btn"
                  onClick={() => toggleSort("affiliated")}
                >
                  Affiliated{sortIndicator("affiliated")}
                </button>
              </th>
              <th scope="col">
                <button
                  type="button"
                  className="members-th-btn"
                  onClick={() => toggleSort("login")}
                >
                  Last login{sortIndicator("login")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="members-empty">
                  Loading member list…
                </td>
              </tr>
            ) : sortedRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="members-empty">
                  No members to show.
                </td>
              </tr>
            ) : (
              pageSlice.map((m) => (
                <tr key={m.ssmId}>
                  <td className="members-col-photo">
                    {m.profilePictureUrl ? (
                      <img
                        className="members-avatar-img"
                        src={m.profilePictureUrl}
                        alt=""
                      />
                    ) : (
                      <span
                        className="members-avatar"
                        aria-hidden
                        title={`${m.firstName} ${m.lastName}`}
                      >
                        {initials(m.firstName, m.lastName)}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="members-name">
                      <span className="members-name-full">
                        {m.firstName} {m.lastName}
                      </span>
                      {m.userName &&
                      m.userName !== m.firstName &&
                      m.userName !== `${m.firstName} ${m.lastName}` ? (
                        <span className="members-username">
                          @{m.userName}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {m.email ? (
                      <a href={`mailto:${m.email}`}>{m.email}</a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{primaryPhone(m)}</td>
                  <td>{displayRating(m.ratingSingles)}</td>
                  <td>{displayRating(m.ratingDoubles)}</td>
                  <td>{m.memberType ?? "—"}</td>
                  <td>
                    <code className="members-code">{m.customId ?? "—"}</code>
                  </td>
                  <td>{formatShortDate(m.affiliatedOn)}</td>
                  <td>{formatShortDate(m.lastLogin)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="members-footer">
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => {
            load().catch(() => {
              /* handled in load */
            });
          }}
        >
          Refresh
        </button>
        <label className="members-page-size">
          <span>Rows per page</span>
          <select
            value={pageSize}
            disabled={loading || sortedRows.length === 0}
            onChange={(e) => {
              setPageSize(
                Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number],
              );
              setPage(1);
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div
          className="members-pager-nav"
          role="navigation"
          aria-label="Members pagination"
        >
          <button
            type="button"
            className="secondary"
            disabled={loading || sortedRows.length === 0 || safePage <= 1}
            onClick={() => setPage(1)}
          >
            First
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading || sortedRows.length === 0 || safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            Previous
          </button>
          <span className="members-pager-status">
            Page {sortedRows.length === 0 ? 0 : safePage} / {pageCount}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={
              loading || sortedRows.length === 0 || safePage >= pageCount
            }
            onClick={() => setPage(safePage + 1)}
          >
            Next
          </button>
          <button
            type="button"
            className="secondary"
            disabled={
              loading || sortedRows.length === 0 || safePage >= pageCount
            }
            onClick={() => setPage(pageCount)}
          >
            Last
          </button>
        </div>
      </div>
    </div>
  );
}
