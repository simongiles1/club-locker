import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Filter, RefreshCw } from "lucide-react";
import {
  BOX_EML_TEMPLATE_VARIABLE_DESCRIPTIONS,
  DEFAULT_BOX_EML_BODY_TEMPLATE,
  DEFAULT_BOX_EML_SUBJECT_TEMPLATE,
  DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
  DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE,
  DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
  DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE,
  EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS,
  WEEKLY_BOX_TEMPLATE_VARIABLE_DESCRIPTIONS,
  WEEKLY_MATCHUP_TEMPLATE_VARIABLE_DESCRIPTIONS,
  buildOutlookEmlFile,
  interpolateEmailTemplate,
  mergeUniqueEmailAddresses,
  weeklyBoxEmlFilename,
  weeklyMatchupEmlFilename,
  type BoxEmlTemplatePurpose,
  type EmailTemplateScope,
  type WeeklyEmailRecipientMode,
} from "@squash/shared";
import { api, downloadBlob, downloadTextFile } from "./api.js";
import { EmlRichTextEditor } from "./EmlRichTextEditor.js";
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

type EmailOutboxApiRow = {
  id: string;
  kind: string;
  seasonId: string | null;
  status: string;
  scheduledSendAt: string | null;
  sentAt: string | null;
  toAddress: string;
  subject: string;
  body: string;
  metaJson: string | null;
  createdAt: string;
};

type InboundEmailApiRow = {
  id: string;
  messageId: string;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  aliasTag: string | null;
  mailboxScope: string | null;
  receivedAt: string;
  processedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
};

type InboundActionApiRow = {
  id: string;
  emailId: string;
  kind: string;
  payloadJson: string | null;
  confidence: string | null;
  status: string;
  appliedAt: string | null;
  appliedRefId: string | null;
  createdAt: string;
};

type BoxEmlPreviewBox = {
  boxNumber: number;
  managed: boolean;
  filename: string;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  interpolationVars: Record<string, string>;
};

type BoxEmlTemplatePair = {
  bodyTemplate: string;
  subjectTemplate: string;
};

type BoxEmlTemplateSettings = {
  managed: BoxEmlTemplatePair;
  unmanaged: BoxEmlTemplatePair;
};

type BoxEmlTemplateEditorTab = "managed" | "unmanaged";

type EmlPurposeDrafts = {
  managedBody: string;
  managedSubject: string;
  unmanagedBody: string;
  unmanagedSubject: string;
};

const BOX_EML_TEMPLATE_PURPOSE_OPTIONS: {
  value: BoxEmlTemplatePurpose;
  label: string;
}[] = [
  { value: "season_start", label: "Season start" },
  { value: "box_modification", label: "Box changes" },
];

function defaultEmlDraftsForPurpose(purpose: BoxEmlTemplatePurpose): EmlPurposeDrafts {
  if (purpose === "box_modification") {
    return {
      managedBody: DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
      managedSubject: DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE,
      unmanagedBody: DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
      unmanagedSubject: DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE,
    };
  }
  return {
    managedBody: DEFAULT_BOX_EML_BODY_TEMPLATE,
    managedSubject: DEFAULT_BOX_EML_SUBJECT_TEMPLATE,
    unmanagedBody: DEFAULT_BOX_EML_BODY_TEMPLATE,
    unmanagedSubject: DEFAULT_BOX_EML_SUBJECT_TEMPLATE,
  };
}

function draftsFromTemplateSettings(row: BoxEmlTemplateSettings): EmlPurposeDrafts {
  return {
    managedBody: row.managed.bodyTemplate,
    managedSubject: row.managed.subjectTemplate,
    unmanagedBody: row.unmanaged.bodyTemplate,
    unmanagedSubject: row.unmanaged.subjectTemplate,
  };
}

type BoxEmlBundleResponse = {
  seasonName: string;
  seasonStartDateLabel: string;
  warnings: string[];
  boxes: BoxEmlPreviewBox[];
};

type WeeklyBoxPreviewRow = {
  boxNumber: number;
  managed: boolean;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  skippedReason?: string;
};

type WeeklyEmailPreviewItem = {
  itemKey: string;
  recipientKind: "box" | "matchup";
  boxNumber: number;
  matchIndex: number;
  label: string;
  managed: boolean;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  skippedReason?: string;
};

type WeeklyBoxBundleResponse = {
  seasonName: string;
  weekNumber: number;
  weekPlayDateLabel: string;
  managedWeekConverted: boolean;
  recipientMode: WeeklyEmailRecipientMode;
  warnings: string[];
  boxes: WeeklyBoxPreviewRow[];
  items: WeeklyEmailPreviewItem[];
};

type WeeklyEmailTemplateGroup = {
  managed: BoxEmlTemplatePair;
  unmanaged: BoxEmlTemplatePair;
};

type WeeklyBoxEmailSettings = {
  enabled: boolean;
  seasonId: string | null;
  recipientMode: WeeklyEmailRecipientMode;
  fromEmail: string;
  fromName: string;
  alternateFromEmails: string[];
  templates: {
    perBox: WeeklyEmailTemplateGroup;
    perMatchup: WeeklyEmailTemplateGroup;
  };
};

type WeeklyPanelView = "preview" | "editor" | "from";

type EmailInboxPair = {
  email: InboundEmailApiRow;
  action: InboundActionApiRow | null;
};

const OUTBOX_MAIL_COLUMNS = [
  "dateSent",
  "status",
  "kind",
  "toAddress",
  "subject",
  "actions",
] as const;

type OutboxMailColumnKey = (typeof OUTBOX_MAIL_COLUMNS)[number];

const INBOX_MAIL_COLUMNS = [
  "dateSent",
  "fromAddress",
  "toAddress",
  "tag",
  "subject",
  "action",
] as const;

type InboxMailColumnKey = (typeof INBOX_MAIL_COLUMNS)[number];
type MailSortDir = "asc" | "desc";

/** Local-day range filter for the shared “date sent” column (outbox + inbox grids). */
type MailGridDateSentRangeFilter = { from: string; to: string };

/** Single header label and column key for outbound send time vs inbound ingest time (same UI). */
const MAIL_GRID_DATE_COLUMN_LABEL = "Date sent";
const MAIL_GRID_DATE_SENT_COLUMN_KEY: "dateSent" = "dateSent";

/** Display like “May 5, 2026 4:45 PM”. */
function formatMailDateSentLabel(iso: string): string {
  const raw = iso.trim();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const month = d.toLocaleString("en-US", { month: "long" });
  const day = d.getDate();
  const year = d.getFullYear();
  const time = d.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${month} ${day}, ${year} ${time}`;
}

function outboxWhenIso(row: EmailOutboxApiRow): string {
  return (
    row.sentAt?.trim() ||
    row.scheduledSendAt?.trim() ||
    row.createdAt
  ).trim();
}

function inboxWhenIso(pair: EmailInboxPair): string {
  return pair.email.receivedAt.trim();
}

function outboxActionsFilterLabel(row: EmailOutboxApiRow): string {
  if (row.status === "draft") return "Approve pending";
  if (row.status === "approved") return "Send pending";
  return row.status || "—";
}

function outboxCellFilterValue(row: EmailOutboxApiRow, col: OutboxMailColumnKey): string {
  switch (col) {
    case "dateSent":
      return formatMailDateSentLabel(outboxWhenIso(row));
    case "status":
      return row.status;
    case "kind":
      return row.kind;
    case "toAddress":
      return row.toAddress;
    case "subject":
      return row.subject;
    case "actions":
      return outboxActionsFilterLabel(row);
    default:
      return "";
  }
}

function outboxRowPassesColumnFilters(
  row: EmailOutboxApiRow,
  filters: Partial<Record<OutboxMailColumnKey, Set<string>>>,
  universes: Record<OutboxMailColumnKey, string[]>,
  dateSentRange: MailGridDateSentRangeFilter,
): boolean {
  if (!mailTimestampInLocalDayRange(outboxWhenIso(row), dateSentRange)) {
    return false;
  }
  for (const col of OUTBOX_MAIL_COLUMNS) {
    if (col === MAIL_GRID_DATE_SENT_COLUMN_KEY) continue;
    const sel = filters[col];
    if (!sel) continue;
    const uni = universes[col];
    if (sel.size === 0) return false;
    if (uni.length > 0 && sel.size === uni.length) continue;
    const v = outboxCellFilterValue(row, col);
    if (!sel.has(v)) return false;
  }
  return true;
}

function compareOutboxMailRows(
  a: EmailOutboxApiRow,
  b: EmailOutboxApiRow,
  key: OutboxMailColumnKey,
  dir: MailSortDir,
): number {
  const m = dir === "asc" ? 1 : -1;
  let c = 0;
  switch (key) {
    case "dateSent": {
      const ta = new Date(outboxWhenIso(a)).getTime();
      const tb = new Date(outboxWhenIso(b)).getTime();
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      c = na - nb;
      break;
    }
    case "status":
      c = a.status.localeCompare(b.status, undefined, { sensitivity: "base" });
      break;
    case "kind":
      c = a.kind.localeCompare(b.kind, undefined, { sensitivity: "base" });
      break;
    case "toAddress":
      c = a.toAddress.localeCompare(b.toAddress, undefined, {
        sensitivity: "base",
      });
      break;
    case "subject":
      c = a.subject.localeCompare(b.subject, undefined, {
        sensitivity: "base",
      });
      break;
    case "actions":
      c = outboxActionsFilterLabel(a).localeCompare(
        outboxActionsFilterLabel(b),
        undefined,
        { sensitivity: "base" },
      );
      break;
    default:
      c = 0;
  }
  if (c !== 0) return c * m;
  return a.id.localeCompare(b.id) * m;
}

function inboxTagFilterLabel(em: InboundEmailApiRow): string {
  const scope = em.mailboxScope?.trim();
  if (scope) return scope;
  const tag = em.aliasTag?.trim();
  if (tag) return tag;
  return "—";
}

function inboxActionFilterLabel(pair: EmailInboxPair): string {
  const act = pair.action;
  if (!act) return "—";
  return `${act.kind} ${act.status}`;
}

function inboxCellFilterValue(
  pair: EmailInboxPair,
  col: InboxMailColumnKey,
): string {
  const em = pair.email;
  switch (col) {
    case "dateSent":
      return formatMailDateSentLabel(inboxWhenIso(pair));
    case "fromAddress":
      return em.fromAddress;
    case "toAddress":
      return em.toAddress;
    case "tag":
      return inboxTagFilterLabel(em);
    case "subject":
      return em.subject?.trim() ? em.subject : "—";
    case "action":
      return inboxActionFilterLabel(pair);
    default:
      return "";
  }
}

/** Local calendar day from `yyyy-mm-dd`; `endOfDay` uses 23:59:59.999. */
function parseYmdLocalBoundary(ymd: string, endOfDay: boolean): number | null {
  const raw = ymd.trim();
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = endOfDay
    ? new Date(y, mo - 1, d, 23, 59, 59, 999)
    : new Date(y, mo - 1, d, 0, 0, 0, 0);
  const t = dt.getTime();
  return Number.isNaN(t) ? null : t;
}

function mailTimestampInLocalDayRange(
  timestampIso: string,
  range: MailGridDateSentRangeFilter,
): boolean {
  const f = parseYmdLocalBoundary(range.from, false);
  const tEnd = parseYmdLocalBoundary(range.to, true);
  if (f === null && tEnd === null) return true;
  let fromT = f;
  let toT = tEnd;
  if (fromT !== null && toT !== null && fromT > toT) {
    fromT = parseYmdLocalBoundary(range.to, false);
    toT = parseYmdLocalBoundary(range.from, true);
  }
  const ts = new Date(timestampIso.trim()).getTime();
  if (Number.isNaN(ts)) return false;
  if (fromT !== null && ts < fromT) return false;
  if (toT !== null && ts > toT) return false;
  return true;
}

function inboxRowPassesColumnFilters(
  pair: EmailInboxPair,
  filters: Partial<Record<InboxMailColumnKey, Set<string>>>,
  universes: Record<InboxMailColumnKey, string[]>,
  dateSentRange: MailGridDateSentRangeFilter,
): boolean {
  if (!mailTimestampInLocalDayRange(inboxWhenIso(pair), dateSentRange)) {
    return false;
  }
  for (const col of INBOX_MAIL_COLUMNS) {
    if (col === MAIL_GRID_DATE_SENT_COLUMN_KEY) continue;
    const sel = filters[col];
    if (!sel) continue;
    const uni = universes[col];
    if (sel.size === 0) return false;
    if (uni.length > 0 && sel.size === uni.length) continue;
    const v = inboxCellFilterValue(pair, col);
    if (!sel.has(v)) return false;
  }
  return true;
}

function compareInboxPairs(
  a: EmailInboxPair,
  b: EmailInboxPair,
  key: InboxMailColumnKey,
  dir: MailSortDir,
): number {
  const m = dir === "asc" ? 1 : -1;
  let c = 0;
  switch (key) {
    case "dateSent": {
      const ta = new Date(inboxWhenIso(a)).getTime();
      const tb = new Date(inboxWhenIso(b)).getTime();
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      c = na - nb;
      break;
    }
    case "fromAddress":
      c = a.email.fromAddress.localeCompare(b.email.fromAddress, undefined, {
        sensitivity: "base",
      });
      break;
    case "toAddress":
      c = a.email.toAddress.localeCompare(b.email.toAddress, undefined, {
        sensitivity: "base",
      });
      break;
    case "tag":
      c = inboxTagFilterLabel(a.email).localeCompare(
        inboxTagFilterLabel(b.email),
        undefined,
        { sensitivity: "base" },
      );
      break;
    case "subject":
      c = (a.email.subject ?? "").localeCompare(b.email.subject ?? "", undefined, {
        sensitivity: "base",
      });
      break;
    case "action":
      c = inboxActionFilterLabel(a).localeCompare(inboxActionFilterLabel(b), undefined, {
        sensitivity: "base",
      });
      break;
    default:
      c = 0;
  }
  if (c !== 0) return c * m;
  return a.email.id.localeCompare(b.email.id) * m;
}

const MAIL_FILTER_POPOVER_VIEWPORT_PAD = 8;

function computeClampedPopoverPosition(
  anchor: DOMRect,
  popWidth: number,
  popHeight: number,
): { top: number; left: number } {
  const pad = MAIL_FILTER_POPOVER_VIEWPORT_PAD;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left;
  let top = anchor.bottom + 4;
  if (left + popWidth > vw - pad) {
    left = anchor.right - popWidth;
  }
  if (left < pad) left = pad;
  if (left + popWidth > vw - pad) {
    left = Math.max(pad, vw - popWidth - pad);
  }
  if (top + popHeight > vh - pad) {
    const above = anchor.top - popHeight - 4;
    if (above >= pad) top = above;
    else top = Math.max(pad, vh - popHeight - pad);
  }
  return { top, left };
}

function EmailColumnFilterPopover({
  rect,
  universe,
  selection,
  onChange,
  onClose,
  anchorRef,
}: {
  rect: DOMRect;
  universe: string[];
  selection: Set<string> | undefined;
  onChange: (next: Set<string> | undefined) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [filterSearch, setFilterSearch] = useState("");
  const [placement, setPlacement] = useState(() => ({
    top: rect.bottom + 4,
    left: rect.left,
  }));

  const effective = selection ?? new Set(universe);
  const q = filterSearch.trim().toLowerCase();
  const visibleUniverse = useMemo(() => {
    if (!q) return universe;
    return universe.filter((v) => v.toLowerCase().includes(q));
  }, [universe, q]);

  const allChecked = !selection || selection.size === universe.length;
  const allIndeterminate =
    !!selection &&
    selection.size > 0 &&
    selection.size < universe.length;

  useLayoutEffect(() => {
    const el = allRef.current;
    if (el) el.indeterminate = allIndeterminate;
  }, [allIndeterminate]);

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPlacement(computeClampedPopoverPosition(rect, box.width, box.height));
  }, [
    rect.top,
    rect.left,
    rect.right,
    rect.bottom,
    universe.length,
    filterSearch,
  ]);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [anchorRef, onClose]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  function toggleValue(v: string) {
    const full = new Set(universe);
    const base = selection ?? full;
    const next = new Set(base);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    if (next.size === full.size) onChange(undefined);
    else onChange(next);
  }

  const style: CSSProperties = {
    position: "fixed",
    top: placement.top,
    left: placement.left,
    minWidth: Math.max(rect.width, 200),
    maxWidth: "min(320px, calc(100vw - 16px))",
    zIndex: 4000,
  };

  return createPortal(
    <div
      ref={popRef}
      className="emails-col-filter-popover"
      role="dialog"
      aria-label="Column filter"
      style={style}
    >
      <div className="emails-col-filter-popover__head">
        <label className="emails-col-filter-popover__all">
          <input
            ref={allRef}
            type="checkbox"
            checked={allChecked}
            onChange={(e) => {
              if (e.target.checked) onChange(undefined);
              else onChange(new Set());
            }}
          />
          <span>All</span>
        </label>
        {universe.length > 0 ? (
          <div className="emails-col-filter-popover__search-row">
            <input
              ref={searchRef}
              type="search"
              className="emails-col-filter-popover__search"
              placeholder="Search…"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              aria-label="Search filter options"
            />
          </div>
        ) : null}
      </div>
      <div className="emails-col-filter-popover__scroller">
        {universe.length === 0 ? (
          <p className="emails-col-filter-popover__empty">No values</p>
        ) : visibleUniverse.length === 0 ? (
          <p className="emails-col-filter-popover__empty">No matching values</p>
        ) : (
          <ul className="emails-col-filter-popover__list">
            {visibleUniverse.map((v, idx) => (
              <li key={`${idx}-${v || "_"}`}>
                <label className="emails-col-filter-popover__item">
                  <input
                    type="checkbox"
                    checked={effective.has(v)}
                    onChange={() => toggleValue(v)}
                  />
                  <span className="emails-col-filter-popover__item-text" title={v}>
                    {v || "—"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

function EmailMailDateRangeFilterPopover({
  rect,
  from,
  to,
  onChange,
  onClose,
  anchorRef,
}: {
  rect: DOMRect;
  from: string;
  to: string;
  onChange: (next: MailGridDateSentRangeFilter) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const inverted =
    !!from.trim() &&
    !!to.trim() &&
    from.trim() > to.trim();

  const [placement, setPlacement] = useState(() => ({
    top: rect.bottom + 4,
    left: rect.left,
  }));

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPlacement(computeClampedPopoverPosition(rect, box.width, box.height));
  }, [rect.top, rect.left, rect.right, rect.bottom, from, to, inverted]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [anchorRef, onClose]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const style: CSSProperties = {
    position: "fixed",
    top: placement.top,
    left: placement.left,
    minWidth: Math.max(rect.width, 220),
    maxWidth: "min(320px, calc(100vw - 16px))",
    zIndex: 4000,
  };

  return createPortal(
    <div
      ref={popRef}
      className="emails-col-filter-popover emails-col-filter-popover--date-range"
      role="dialog"
      aria-label="Date sent range filter"
      style={style}
    >
      <div className="emails-col-filter-popover__scroller">
        <div className="emails-col-filter-popover__date-fields">
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => onChange({ from: e.target.value, to })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              onChange={(e) => onChange({ from, to: e.target.value })}
            />
          </label>
          {inverted ? (
            <p className="emails-col-filter-popover__date-hint">
              Start is after end — range is applied with dates treated in
              reverse order.
            </p>
          ) : (
            <p className="emails-col-filter-popover__date-hint">
              Leave either field empty for an open-ended bound. Times use your
              local time zone.
            </p>
          )}
          <div className="emails-col-filter-popover__date-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => onChange({ from: "", to: "" })}
            >
              Clear range
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MailSortFilterTh<T extends string>({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  filterActive,
  onFilterClick,
}: {
  label: string;
  column: T;
  sortKey: T;
  sortDir: MailSortDir;
  onSort: (column: T) => void;
  filterActive: boolean;
  onFilterClick: (ev: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const active = sortKey === column;
  return (
    <th
      className="houseleague-th-sort-cell emails-mail-th-cell"
      scope="col"
      aria-sort={
        active ? (sortDir === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <div className="emails-mail-th-toolbar">
        <button
          type="button"
          className={`houseleague-th-sort emails-mail-th-sort${active ? " houseleague-th-sort--active" : ""}`}
          onClick={() => onSort(column)}
        >
          {label}
          <span
            className={
              active
                ? "houseleague-th-sort__dir"
                : "houseleague-th-sort__dir houseleague-th-sort__dir--reserved"
            }
            aria-hidden
          >
            {active ? (sortDir === "asc" ? "↑" : "↓") : "↑"}
          </span>
        </button>
        <button
          type="button"
          className={
            filterActive
              ? "emails-mail-col-filter emails-mail-col-filter--active"
              : "emails-mail-col-filter"
          }
          aria-label={`Filter ${label}`}
          title="Filter"
          onClick={onFilterClick}
        >
          <Filter size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </th>
  );
}

export function EmailsPage({
  onLog,
  templateScope,
  showPageHeading = true,
  linkedSeasonId,
}: {
  onLog: (s: string) => void;
  templateScope: EmailTemplateScope;
  showPageHeading?: boolean;
  /** When set (e.g. active booking season), outbound list prefers rows for this `email_outbox.season_id`. */
  linkedSeasonId?: string | null;
}) {
  const listingArea =
    templateScope === "house_league" ? "house_league" : "championships";
  const showScheduleTab = templateScope === "house_league";
  const showEmlTab = templateScope === "house_league" && Boolean(linkedSeasonId?.trim());
  const showWeeklyTab =
    templateScope === "house_league" && Boolean(linkedSeasonId?.trim());
  const [subTab, setSubTab] = useState<
    "email" | "templates" | "schedule" | "eml" | "weekly"
  >("email");
  const [emailPanelTab, setEmailPanelTab] = useState<"inbox" | "outbox">(
    "outbox",
  );
  const [outboundRows, setOutboundRows] = useState<EmailOutboxApiRow[]>([]);
  const [inboundPairs, setInboundPairs] = useState<EmailInboxPair[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
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

  const [emlBundle, setEmlBundle] = useState<BoxEmlBundleResponse | null>(null);
  const [emlLoading, setEmlLoading] = useState(false);
  const [emlZipLoading, setEmlZipLoading] = useState(false);
  const [emlPreviewBox, setEmlPreviewBox] = useState<number | "">("");
  const [emlTemplatePurpose, setEmlTemplatePurpose] =
    useState<BoxEmlTemplatePurpose>("season_start");
  const [emlSavedByPurpose, setEmlSavedByPurpose] = useState<
    Partial<Record<BoxEmlTemplatePurpose, BoxEmlTemplateSettings>>
  >({});
  const [emlDraftsByPurpose, setEmlDraftsByPurpose] = useState<
    Record<BoxEmlTemplatePurpose, EmlPurposeDrafts>
  >({
    season_start: defaultEmlDraftsForPurpose("season_start"),
    box_modification: defaultEmlDraftsForPurpose("box_modification"),
  });
  const [emlTemplateEditorTab, setEmlTemplateEditorTab] =
    useState<BoxEmlTemplateEditorTab>("managed");
  const [emlTemplateSaving, setEmlTemplateSaving] = useState(false);
  const [emlTemplateEditorResetKey, setEmlTemplateEditorResetKey] = useState(0);

  const [weeklySettings, setWeeklySettings] = useState<WeeklyBoxEmailSettings | null>(
    null,
  );
  const [weeklyFormEnabled, setWeeklyFormEnabled] = useState(false);
  const [weeklySaving, setWeeklySaving] = useState(false);
  const [weeklyBundle, setWeeklyBundle] = useState<WeeklyBoxBundleResponse | null>(
    null,
  );
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyZipLoading, setWeeklyZipLoading] = useState(false);
  const [weeklyWeek, setWeeklyWeek] = useState<number | "">("");
  const [weeklyPreviewItemKey, setWeeklyPreviewItemKey] = useState("");
  const [weeklyPanelView, setWeeklyPanelView] = useState<WeeklyPanelView>("preview");
  const [weeklyRecipientModeForm, setWeeklyRecipientModeForm] =
    useState<WeeklyEmailRecipientMode>("per_box");
  const [weeklyTemplateEditorTab, setWeeklyTemplateEditorTab] =
    useState<BoxEmlTemplateEditorTab>("managed");
  const [weeklyPerBoxManagedBodyDraft, setWeeklyPerBoxManagedBodyDraft] =
    useState("");
  const [weeklyPerBoxManagedSubjectDraft, setWeeklyPerBoxManagedSubjectDraft] =
    useState("");
  const [weeklyPerBoxUnmanagedBodyDraft, setWeeklyPerBoxUnmanagedBodyDraft] =
    useState("");
  const [weeklyPerBoxUnmanagedSubjectDraft, setWeeklyPerBoxUnmanagedSubjectDraft] =
    useState("");
  const [weeklyPerMatchupManagedBodyDraft, setWeeklyPerMatchupManagedBodyDraft] =
    useState("");
  const [
    weeklyPerMatchupManagedSubjectDraft,
    setWeeklyPerMatchupManagedSubjectDraft,
  ] = useState("");
  const [
    weeklyPerMatchupUnmanagedBodyDraft,
    setWeeklyPerMatchupUnmanagedBodyDraft,
  ] = useState("");
  const [
    weeklyPerMatchupUnmanagedSubjectDraft,
    setWeeklyPerMatchupUnmanagedSubjectDraft,
  ] = useState("");
  const [weeklyTemplateSaving, setWeeklyTemplateSaving] = useState(false);
  const [weeklySendLoading, setWeeklySendLoading] = useState(false);
  const [weeklyTemplateEditorResetKey, setWeeklyTemplateEditorResetKey] =
    useState(0);
  const [weeklyFromEmail, setWeeklyFromEmail] = useState("");
  const [weeklyFromName, setWeeklyFromName] = useState("");
  const [weeklyAlternateFromEmails, setWeeklyAlternateFromEmails] = useState<
    string[]
  >([]);
  const [weeklyAddEmailModalOpen, setWeeklyAddEmailModalOpen] = useState(false);
  const [weeklyAddEmailInput, setWeeklyAddEmailInput] = useState("");

  const outboxFilterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const inboxFilterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [outboxMailSort, setOutboxMailSort] = useState<{
    key: OutboxMailColumnKey;
    dir: MailSortDir;
  }>({ key: "dateSent", dir: "desc" });
  const [outboxColumnFilters, setOutboxColumnFilters] = useState<
    Partial<Record<OutboxMailColumnKey, Set<string>>>
  >({});
  const [outboxFilterOpenColumn, setOutboxFilterOpenColumn] =
    useState<OutboxMailColumnKey | null>(null);
  const [outboxFilterRect, setOutboxFilterRect] = useState<DOMRect | null>(
    null,
  );
  const [inboxMailSort, setInboxMailSort] = useState<{
    key: InboxMailColumnKey;
    dir: MailSortDir;
  }>({ key: MAIL_GRID_DATE_SENT_COLUMN_KEY, dir: "desc" });
  const [inboxColumnFilters, setInboxColumnFilters] = useState<
    Partial<Record<InboxMailColumnKey, Set<string>>>
  >({});
  const [inboxFilterOpenColumn, setInboxFilterOpenColumn] =
    useState<InboxMailColumnKey | null>(null);
  const [inboxFilterRect, setInboxFilterRect] = useState<DOMRect | null>(
    null,
  );
  const [mailGridDateSentRanges, setMailGridDateSentRanges] = useState<{
    outbox: MailGridDateSentRangeFilter;
    inbox: MailGridDateSentRangeFilter;
  }>({ outbox: { from: "", to: "" }, inbox: { from: "", to: "" } });

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

  const loadOutboxList = useCallback(async () => {
    setMailLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("area", listingArea);
      qs.set("limit", "250");
      const sid = linkedSeasonId?.trim();
      if (sid) qs.set("seasonId", sid);
      const rows = await api<EmailOutboxApiRow[]>(
        `/api/email-outbox?${qs.toString()}`,
      );
      setOutboundRows(rows);
    } catch (e) {
      onLog(String(e));
    } finally {
      setMailLoading(false);
    }
  }, [listingArea, linkedSeasonId, onLog]);

  const loadInboxList = useCallback(async () => {
    setMailLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("area", listingArea);
      qs.set("limit", "250");
      const rows = await api<EmailInboxPair[]>(
        `/api/email-inbox?${qs.toString()}`,
      );
      setInboundPairs(rows);
    } catch (e) {
      onLog(String(e));
    } finally {
      setMailLoading(false);
    }
  }, [listingArea, onLog]);

  useEffect(() => {
    setOutboxFilterOpenColumn(null);
    setInboxFilterOpenColumn(null);
  }, [emailPanelTab, subTab]);

  useEffect(() => {
    if (subTab !== "email") return;
    if (emailPanelTab === "outbox") void loadOutboxList();
    else void loadInboxList();
  }, [subTab, emailPanelTab, loadOutboxList, loadInboxList]);

  useEffect(() => {
    if (subTab !== "templates") return;
    void loadTemplates();
  }, [subTab, loadTemplates]);

  useEffect(() => {
    if (!(subTab === "schedule" && showScheduleTab)) return;
    void loadHlSettings();
    void loadTemplates();
  }, [subTab, showScheduleTab, loadHlSettings, loadTemplates]);

  const loadEmlTemplate = useCallback(
    async (purpose: BoxEmlTemplatePurpose) => {
      try {
        const row = await api<BoxEmlTemplateSettings>(
          `/api/house-league/box-eml-template?purpose=${encodeURIComponent(purpose)}`,
        );
        setEmlSavedByPurpose((prev) => ({ ...prev, [purpose]: row }));
        setEmlDraftsByPurpose((prev) => ({
          ...prev,
          [purpose]: draftsFromTemplateSettings(row),
        }));
      } catch (e) {
        onLog(String(e));
      }
    },
    [onLog],
  );

  const loadEmlBundle = useCallback(async () => {
    const sid = linkedSeasonId?.trim();
    if (!sid) return;
    setEmlLoading(true);
    try {
      const bundle = await api<BoxEmlBundleResponse>(
        `/api/seasons/${encodeURIComponent(sid)}/house-league/box-eml?purpose=${encodeURIComponent(emlTemplatePurpose)}`,
      );
      setEmlBundle(bundle);
      setEmlPreviewBox((prev) => {
        if (prev !== "" && bundle.boxes.some((b) => b.boxNumber === prev)) {
          return prev;
        }
        return bundle.boxes[0]?.boxNumber ?? "";
      });
    } catch (e) {
      onLog(String(e));
      setEmlBundle(null);
    } finally {
      setEmlLoading(false);
    }
  }, [emlTemplatePurpose, linkedSeasonId, onLog]);

  useEffect(() => {
    if (subTab !== "eml" || !showEmlTab) return;
    void loadEmlTemplate(emlTemplatePurpose);
    void loadEmlBundle();
  }, [subTab, showEmlTab, emlTemplatePurpose, loadEmlTemplate, loadEmlBundle]);

  const loadWeeklySettings = useCallback(async () => {
    try {
      const row = await api<WeeklyBoxEmailSettings>(
        "/api/house-league/weekly-box-email-settings",
      );
      setWeeklySettings(row);
      setWeeklyFormEnabled(row.enabled);
      setWeeklyRecipientModeForm(row.recipientMode);
      setWeeklyFromEmail(row.fromEmail);
      setWeeklyFromName(row.fromName);
      setWeeklyAlternateFromEmails(row.alternateFromEmails);
      setWeeklyPerBoxManagedBodyDraft(row.templates.perBox.managed.bodyTemplate);
      setWeeklyPerBoxManagedSubjectDraft(row.templates.perBox.managed.subjectTemplate);
      setWeeklyPerBoxUnmanagedBodyDraft(row.templates.perBox.unmanaged.bodyTemplate);
      setWeeklyPerBoxUnmanagedSubjectDraft(
        row.templates.perBox.unmanaged.subjectTemplate,
      );
      setWeeklyPerMatchupManagedBodyDraft(
        row.templates.perMatchup.managed.bodyTemplate,
      );
      setWeeklyPerMatchupManagedSubjectDraft(
        row.templates.perMatchup.managed.subjectTemplate,
      );
      setWeeklyPerMatchupUnmanagedBodyDraft(
        row.templates.perMatchup.unmanaged.bodyTemplate,
      );
      setWeeklyPerMatchupUnmanagedSubjectDraft(
        row.templates.perMatchup.unmanaged.subjectTemplate,
      );
    } catch (e) {
      onLog(String(e));
    }
  }, [onLog]);

  const loadWeeklyBundle = useCallback(async () => {
    const sid = linkedSeasonId?.trim();
    if (!sid) return;
    setWeeklyLoading(true);
    try {
      const qs = new URLSearchParams();
      if (weeklyWeek !== "") qs.set("week", String(weeklyWeek));
      const path = `/api/seasons/${encodeURIComponent(sid)}/house-league/weekly-box-email?${qs.toString()}`;
      const bundle = await api<WeeklyBoxBundleResponse>(path);
      setWeeklyBundle(bundle);
      if (weeklyWeek === "") setWeeklyWeek(bundle.weekNumber);
      setWeeklyRecipientModeForm(bundle.recipientMode);
      setWeeklyPreviewItemKey((prev) => {
        if (prev && bundle.items.some((i) => i.itemKey === prev)) return prev;
        const first = bundle.items.find((i) => !i.skippedReason);
        return first?.itemKey ?? bundle.items[0]?.itemKey ?? "";
      });
    } catch (e) {
      onLog(String(e));
      setWeeklyBundle(null);
    } finally {
      setWeeklyLoading(false);
    }
  }, [linkedSeasonId, onLog, weeklyWeek]);

  useEffect(() => {
    if (subTab !== "weekly" || !showWeeklyTab) return;
    void loadWeeklySettings();
  }, [subTab, showWeeklyTab, loadWeeklySettings]);

  useEffect(() => {
    if (subTab !== "weekly" || !showWeeklyTab) return;
    void loadWeeklyBundle();
  }, [subTab, showWeeklyTab, loadWeeklyBundle]);

  const weeklyPreviewItem = useMemo(() => {
    if (!weeklyBundle || !weeklyPreviewItemKey) return null;
    return (
      weeklyBundle.items.find((i) => i.itemKey === weeklyPreviewItemKey) ?? null
    );
  }, [weeklyBundle, weeklyPreviewItemKey]);

  const weeklyExportableCount = useMemo(() => {
    if (!weeklyBundle) return 0;
    return weeklyBundle.items.filter(
      (i) => !i.skippedReason && i.htmlBody.trim().length > 0,
    ).length;
  }, [weeklyBundle]);

  const weeklyFromEmailChoices = useMemo(
    () =>
      mergeUniqueEmailAddresses(
        [weeklyFromEmail.trim()],
        weeklyAlternateFromEmails,
        weeklySettings?.alternateFromEmails ?? [],
      ),
    [weeklyFromEmail, weeklyAlternateFromEmails, weeklySettings],
  );

  const weeklyUsesPerMatchup =
    weeklyRecipientModeForm === "per_matchup" ||
    weeklyBundle?.recipientMode === "per_matchup";

  const weeklyActiveTemplateVars = weeklyUsesPerMatchup
    ? WEEKLY_MATCHUP_TEMPLATE_VARIABLE_DESCRIPTIONS
    : WEEKLY_BOX_TEMPLATE_VARIABLE_DESCRIPTIONS;

  const weeklyDeliveryDirty = useMemo(() => {
    if (!weeklySettings) return false;
    return (
      weeklyFromEmail !== weeklySettings.fromEmail ||
      weeklyFromName !== weeklySettings.fromName ||
      JSON.stringify(weeklyAlternateFromEmails) !==
        JSON.stringify(weeklySettings.alternateFromEmails)
    );
  }, [weeklySettings, weeklyFromEmail, weeklyFromName, weeklyAlternateFromEmails]);

  const weeklySettingsFormDirty = useMemo(() => {
    if (!weeklySettings) return false;
    return (
      weeklyFormEnabled !== weeklySettings.enabled ||
      weeklyRecipientModeForm !== weeklySettings.recipientMode ||
      weeklyDeliveryDirty
    );
  }, [
    weeklySettings,
    weeklyFormEnabled,
    weeklyRecipientModeForm,
    weeklyDeliveryDirty,
  ]);

  const weeklyActiveBodyDraft = useMemo(() => {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    if (weeklyTemplateEditorTab === "managed") {
      return perMatchup
        ? weeklyPerMatchupManagedBodyDraft
        : weeklyPerBoxManagedBodyDraft;
    }
    return perMatchup
      ? weeklyPerMatchupUnmanagedBodyDraft
      : weeklyPerBoxUnmanagedBodyDraft;
  }, [
    weeklyRecipientModeForm,
    weeklyTemplateEditorTab,
    weeklyPerBoxManagedBodyDraft,
    weeklyPerBoxUnmanagedBodyDraft,
    weeklyPerMatchupManagedBodyDraft,
    weeklyPerMatchupUnmanagedBodyDraft,
  ]);

  const weeklyActiveSubjectDraft = useMemo(() => {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    if (weeklyTemplateEditorTab === "managed") {
      return perMatchup
        ? weeklyPerMatchupManagedSubjectDraft
        : weeklyPerBoxManagedSubjectDraft;
    }
    return perMatchup
      ? weeklyPerMatchupUnmanagedSubjectDraft
      : weeklyPerBoxUnmanagedSubjectDraft;
  }, [
    weeklyRecipientModeForm,
    weeklyTemplateEditorTab,
    weeklyPerBoxManagedSubjectDraft,
    weeklyPerBoxUnmanagedSubjectDraft,
    weeklyPerMatchupManagedSubjectDraft,
    weeklyPerMatchupUnmanagedSubjectDraft,
  ]);

  const weeklyTemplateIsDirty = useMemo(() => {
    if (!weeklySettings) return false;
    const { perBox, perMatchup } = weeklySettings.templates;
    return (
      weeklyPerBoxManagedBodyDraft !== perBox.managed.bodyTemplate ||
      weeklyPerBoxManagedSubjectDraft !== perBox.managed.subjectTemplate ||
      weeklyPerBoxUnmanagedBodyDraft !== perBox.unmanaged.bodyTemplate ||
      weeklyPerBoxUnmanagedSubjectDraft !== perBox.unmanaged.subjectTemplate ||
      weeklyPerMatchupManagedBodyDraft !== perMatchup.managed.bodyTemplate ||
      weeklyPerMatchupManagedSubjectDraft !== perMatchup.managed.subjectTemplate ||
      weeklyPerMatchupUnmanagedBodyDraft !== perMatchup.unmanaged.bodyTemplate ||
      weeklyPerMatchupUnmanagedSubjectDraft !==
        perMatchup.unmanaged.subjectTemplate
    );
  }, [
    weeklyPerBoxManagedBodyDraft,
    weeklyPerBoxManagedSubjectDraft,
    weeklyPerBoxUnmanagedBodyDraft,
    weeklyPerBoxUnmanagedSubjectDraft,
    weeklyPerMatchupManagedBodyDraft,
    weeklyPerMatchupManagedSubjectDraft,
    weeklyPerMatchupUnmanagedBodyDraft,
    weeklyPerMatchupUnmanagedSubjectDraft,
    weeklySettings,
  ]);

  async function saveWeeklySettings() {
    const sid = linkedSeasonId?.trim() ?? null;
    setWeeklySaving(true);
    try {
      const updated = await api<WeeklyBoxEmailSettings>(
        "/api/house-league/weekly-box-email-settings",
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: weeklyFormEnabled,
            seasonId: sid,
            recipientMode: weeklyRecipientModeForm,
            fromEmail: weeklyFromEmail.trim() || undefined,
            fromName: weeklyFromName.trim(),
            alternateFromEmails: weeklyAlternateFromEmails.filter(
              (em) =>
                em.toLowerCase() !== weeklyFromEmail.trim().toLowerCase(),
            ),
          }),
        },
      );
      setWeeklySettings(updated);
      setWeeklyFormEnabled(updated.enabled);
      setWeeklyRecipientModeForm(updated.recipientMode);
      setWeeklyFromEmail(updated.fromEmail);
      setWeeklyFromName(updated.fromName);
      setWeeklyAlternateFromEmails(updated.alternateFromEmails);
      onLog("Weekly email settings saved.");
      void loadWeeklyBundle();
    } catch (e) {
      onLog(String(e));
    } finally {
      setWeeklySaving(false);
    }
  }

  async function saveWeeklyTemplate() {
    setWeeklyTemplateSaving(true);
    try {
      const perMatchup = weeklyRecipientModeForm === "per_matchup";
      const templateGroup = perMatchup
        ? {
            managed: {
              bodyTemplate: weeklyPerMatchupManagedBodyDraft,
              subjectTemplate: weeklyPerMatchupManagedSubjectDraft,
            },
            unmanaged: {
              bodyTemplate: weeklyPerMatchupUnmanagedBodyDraft,
              subjectTemplate: weeklyPerMatchupUnmanagedSubjectDraft,
            },
          }
        : {
            managed: {
              bodyTemplate: weeklyPerBoxManagedBodyDraft,
              subjectTemplate: weeklyPerBoxManagedSubjectDraft,
            },
            unmanaged: {
              bodyTemplate: weeklyPerBoxUnmanagedBodyDraft,
              subjectTemplate: weeklyPerBoxUnmanagedSubjectDraft,
            },
          };
      const row = await api<WeeklyBoxEmailSettings>(
        "/api/house-league/weekly-box-email-settings",
        {
          method: "PATCH",
          body: JSON.stringify({
            templates: perMatchup
              ? { perMatchup: templateGroup }
              : { perBox: templateGroup },
          }),
        },
      );
      setWeeklySettings(row);
      setWeeklyPerBoxManagedBodyDraft(row.templates.perBox.managed.bodyTemplate);
      setWeeklyPerBoxManagedSubjectDraft(row.templates.perBox.managed.subjectTemplate);
      setWeeklyPerBoxUnmanagedBodyDraft(row.templates.perBox.unmanaged.bodyTemplate);
      setWeeklyPerBoxUnmanagedSubjectDraft(
        row.templates.perBox.unmanaged.subjectTemplate,
      );
      setWeeklyPerMatchupManagedBodyDraft(
        row.templates.perMatchup.managed.bodyTemplate,
      );
      setWeeklyPerMatchupManagedSubjectDraft(
        row.templates.perMatchup.managed.subjectTemplate,
      );
      setWeeklyPerMatchupUnmanagedBodyDraft(
        row.templates.perMatchup.unmanaged.bodyTemplate,
      );
      setWeeklyPerMatchupUnmanagedSubjectDraft(
        row.templates.perMatchup.unmanaged.subjectTemplate,
      );
      onLog("Weekly email templates saved.");
      void loadWeeklyBundle();
    } catch (e) {
      onLog(String(e));
    } finally {
      setWeeklyTemplateSaving(false);
    }
  }

  async function sendWeeklyWeek(force = false) {
    const sid = linkedSeasonId?.trim();
    if (!sid || weeklyWeek === "") {
      onLog("Choose a week number.");
      return;
    }
    setWeeklySendLoading(true);
    try {
      const res = await api<{
        ok: boolean;
        staged: number;
        sent: number;
        skipped: number;
        warnings: string[];
      }>(
        `/api/seasons/${encodeURIComponent(sid)}/house-league/weekly-box-email/send`,
        {
          method: "POST",
          body: JSON.stringify({ week: weeklyWeek, force }),
        },
      );
      onLog(
        `Weekly send week ${weeklyWeek}: staged=${res.staged}, sent=${res.sent}, skipped=${res.skipped}.`,
      );
      for (const w of res.warnings) onLog(w);
      void loadOutboxList();
      void loadWeeklyBundle();
    } catch (e) {
      onLog(String(e));
    } finally {
      setWeeklySendLoading(false);
    }
  }

  function resetWeeklyTemplateDraft() {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    const baseline = perMatchup
      ? weeklySettings?.templates.perMatchup
      : weeklySettings?.templates.perBox;
    const fallbackManaged = perMatchup
      ? DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE
      : DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE;
    const fallbackUnmanaged = perMatchup
      ? DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE
      : DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE;
    const fallbackSubject = perMatchup
      ? DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE
      : DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE;
    const managed = baseline?.managed ?? {
      bodyTemplate: fallbackManaged,
      subjectTemplate: fallbackSubject,
    };
    const unmanaged = baseline?.unmanaged ?? {
      bodyTemplate: fallbackUnmanaged,
      subjectTemplate: fallbackSubject,
    };
    if (perMatchup) {
      setWeeklyPerMatchupManagedBodyDraft(managed.bodyTemplate);
      setWeeklyPerMatchupManagedSubjectDraft(managed.subjectTemplate);
      setWeeklyPerMatchupUnmanagedBodyDraft(unmanaged.bodyTemplate);
      setWeeklyPerMatchupUnmanagedSubjectDraft(unmanaged.subjectTemplate);
    } else {
      setWeeklyPerBoxManagedBodyDraft(managed.bodyTemplate);
      setWeeklyPerBoxManagedSubjectDraft(managed.subjectTemplate);
      setWeeklyPerBoxUnmanagedBodyDraft(unmanaged.bodyTemplate);
      setWeeklyPerBoxUnmanagedSubjectDraft(unmanaged.subjectTemplate);
    }
    setWeeklyTemplateEditorResetKey((k) => k + 1);
  }

  function restoreDefaultWeeklyTemplate() {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    if (weeklyTemplateEditorTab === "managed") {
      if (perMatchup) {
        setWeeklyPerMatchupManagedBodyDraft(DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE);
        setWeeklyPerMatchupManagedSubjectDraft(DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE);
      } else {
        setWeeklyPerBoxManagedBodyDraft(DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE);
        setWeeklyPerBoxManagedSubjectDraft(DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE);
      }
    } else if (perMatchup) {
      setWeeklyPerMatchupUnmanagedBodyDraft(DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE);
      setWeeklyPerMatchupUnmanagedSubjectDraft(DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE);
    } else {
      setWeeklyPerBoxUnmanagedBodyDraft(DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE);
      setWeeklyPerBoxUnmanagedSubjectDraft(DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE);
    }
    setWeeklyTemplateEditorResetKey((k) => k + 1);
  }

  function setWeeklyActiveBodyDraft(value: string) {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    if (weeklyTemplateEditorTab === "managed") {
      if (perMatchup) setWeeklyPerMatchupManagedBodyDraft(value);
      else setWeeklyPerBoxManagedBodyDraft(value);
    } else if (perMatchup) {
      setWeeklyPerMatchupUnmanagedBodyDraft(value);
    } else {
      setWeeklyPerBoxUnmanagedBodyDraft(value);
    }
  }

  function setWeeklyActiveSubjectDraft(value: string) {
    const perMatchup = weeklyRecipientModeForm === "per_matchup";
    if (weeklyTemplateEditorTab === "managed") {
      if (perMatchup) setWeeklyPerMatchupManagedSubjectDraft(value);
      else setWeeklyPerBoxManagedSubjectDraft(value);
    } else if (perMatchup) {
      setWeeklyPerMatchupUnmanagedSubjectDraft(value);
    } else {
      setWeeklyPerBoxUnmanagedSubjectDraft(value);
    }
  }

  async function persistWeeklyRecipientMode(mode: WeeklyEmailRecipientMode) {
    setWeeklyRecipientModeForm(mode);
    setWeeklySaving(true);
    try {
      const updated = await api<WeeklyBoxEmailSettings>(
        "/api/house-league/weekly-box-email-settings",
        {
          method: "PATCH",
          body: JSON.stringify({ recipientMode: mode }),
        },
      );
      setWeeklySettings(updated);
      setWeeklyRecipientModeForm(updated.recipientMode);
      onLog(
        mode === "per_matchup"
          ? "Recipient mode: one email per matchup."
          : "Recipient mode: one email per box.",
      );
      void loadWeeklyBundle();
    } catch (e) {
      onLog(String(e));
      setWeeklyRecipientModeForm(weeklySettings?.recipientMode ?? "per_box");
    } finally {
      setWeeklySaving(false);
    }
  }

  function openWeeklyAddEmailModal() {
    setWeeklyAddEmailInput("");
    setWeeklyAddEmailModalOpen(true);
  }

  function commitWeeklyAddEmail() {
    const em = weeklyAddEmailInput.trim();
    if (!em) {
      onLog("Enter an email address.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      onLog("Invalid email address.");
      return;
    }
    const prevActive = weeklyFromEmail.trim();
    setWeeklyAlternateFromEmails((prev) => {
      const withoutNew = prev.filter((x) => x.toLowerCase() !== em.toLowerCase());
      if (
        prevActive &&
        prevActive.toLowerCase() !== em.toLowerCase()
      ) {
        return mergeUniqueEmailAddresses(withoutNew, [prevActive]);
      }
      return withoutNew;
    });
    setWeeklyFromEmail(em);
    setWeeklyAddEmailModalOpen(false);
    setWeeklyAddEmailInput("");
  }

  function downloadWeeklyPreviewEml() {
    if (!weeklyPreviewItem || weeklyWeek === "") {
      onLog("Choose a preview message to download.");
      return;
    }
    const from = weeklyFromEmail.trim();
    if (!from) {
      onLog("Set a From email before downloading.");
      return;
    }
    if (weeklyPreviewItem.skippedReason || !weeklyPreviewItem.htmlBody) {
      onLog("This message has nothing to export.");
      return;
    }
    const to = mergeUniqueEmailAddresses(weeklyPreviewItem.toAddresses);
    if (to.length === 0) {
      onLog("No roster recipients for this message.");
      return;
    }
    const content = buildOutlookEmlFile({
      fromName: weeklyFromName.trim(),
      fromEmail: from,
      toAddresses: to,
      subject: weeklyPreviewItem.subject,
      htmlBody: weeklyPreviewItem.htmlBody,
    });
    const filename =
      weeklyPreviewItem.recipientKind === "matchup"
        ? weeklyMatchupEmlFilename(
            weeklyPreviewItem.boxNumber,
            weeklyWeek,
            weeklyPreviewItem.matchIndex,
          )
        : weeklyBoxEmlFilename(weeklyPreviewItem.boxNumber, weeklyWeek);
    downloadTextFile(content, filename, "message/rfc822");
    onLog(`Downloaded ${filename}.`);
  }

  const weeklyZipFromEmail = useMemo(() => {
    const fromForm = weeklyFromEmail.trim();
    if (fromForm) return fromForm;
    return weeklySettings?.fromEmail.trim() ?? "";
  }, [weeklyFromEmail, weeklySettings]);

  async function downloadAllWeeklyEmlZip() {
    const sid = linkedSeasonId?.trim();
    if (!sid || weeklyWeek === "") return;
    const from = weeklyZipFromEmail;
    if (!from) {
      onLog("Set a From email (From email tab) before downloading.");
      return;
    }
    setWeeklyZipLoading(true);
    try {
      const path = `/api/seasons/${encodeURIComponent(sid)}/house-league/weekly-box-email.zip`;
      const fallback = `house-league-week-${weeklyWeek}-weekly-eml.zip`;
      const needsPost = weeklyTemplateIsDirty || weeklyDeliveryDirty;
      if (needsPost) {
        await downloadBlob(path, fallback, {
          method: "POST",
          body: JSON.stringify({
            week: weeklyWeek,
            fromEmail: from,
            fromName: weeklyFromName.trim(),
            ...(weeklyTemplateIsDirty
              ? {
                  templates: {
                    perBox: {
                      managed: {
                        bodyTemplate: weeklyPerBoxManagedBodyDraft,
                        subjectTemplate: weeklyPerBoxManagedSubjectDraft,
                      },
                      unmanaged: {
                        bodyTemplate: weeklyPerBoxUnmanagedBodyDraft,
                        subjectTemplate: weeklyPerBoxUnmanagedSubjectDraft,
                      },
                    },
                    perMatchup: {
                      managed: {
                        bodyTemplate: weeklyPerMatchupManagedBodyDraft,
                        subjectTemplate: weeklyPerMatchupManagedSubjectDraft,
                      },
                      unmanaged: {
                        bodyTemplate: weeklyPerMatchupUnmanagedBodyDraft,
                        subjectTemplate: weeklyPerMatchupUnmanagedSubjectDraft,
                      },
                    },
                  },
                }
              : {}),
          }),
        });
      } else {
        const qs = new URLSearchParams({
          week: String(weeklyWeek),
          fromEmail: from,
        });
        if (weeklyFromName.trim()) qs.set("fromName", weeklyFromName.trim());
        await downloadBlob(`${path}?${qs.toString()}`, fallback);
      }
      onLog("Downloaded weekly EML zip.");
    } catch (e) {
      onLog(String(e));
    } finally {
      setWeeklyZipLoading(false);
    }
  }

  const emlPreviewBoxRow = useMemo(() => {
    if (!emlBundle || emlPreviewBox === "") return null;
    return emlBundle.boxes.find((b) => b.boxNumber === emlPreviewBox) ?? null;
  }, [emlBundle, emlPreviewBox]);

  const emlActiveDrafts = emlDraftsByPurpose[emlTemplatePurpose];

  const emlActiveBodyDraft =
    emlTemplateEditorTab === "managed"
      ? emlActiveDrafts.managedBody
      : emlActiveDrafts.unmanagedBody;
  const emlActiveSubjectDraft =
    emlTemplateEditorTab === "managed"
      ? emlActiveDrafts.managedSubject
      : emlActiveDrafts.unmanagedSubject;

  const emlTemplateSaved = emlSavedByPurpose[emlTemplatePurpose] ?? null;

  const emlTemplateIsDirty = useMemo(() => {
    if (!emlTemplateSaved) return false;
    const d = emlActiveDrafts;
    return (
      d.managedBody !== emlTemplateSaved.managed.bodyTemplate ||
      d.managedSubject !== emlTemplateSaved.managed.subjectTemplate ||
      d.unmanagedBody !== emlTemplateSaved.unmanaged.bodyTemplate ||
      d.unmanagedSubject !== emlTemplateSaved.unmanaged.subjectTemplate
    );
  }, [emlActiveDrafts, emlTemplateSaved]);

  const emlPreviewSubjectDraft = useMemo(() => {
    if (!emlPreviewBoxRow) return "";
    return emlPreviewBoxRow.managed
      ? emlActiveDrafts.managedSubject
      : emlActiveDrafts.unmanagedSubject;
  }, [emlPreviewBoxRow, emlActiveDrafts]);

  const emlPreviewBodyDraft = useMemo(() => {
    if (!emlPreviewBoxRow) return "";
    return emlPreviewBoxRow.managed
      ? emlActiveDrafts.managedBody
      : emlActiveDrafts.unmanagedBody;
  }, [emlPreviewBoxRow, emlActiveDrafts]);

  const emlPreviewSubject = useMemo(() => {
    if (!emlPreviewBoxRow) return "";
    return interpolateEmailTemplate(
      emlPreviewSubjectDraft,
      emlPreviewBoxRow.interpolationVars,
    ).trim();
  }, [emlPreviewBoxRow, emlPreviewSubjectDraft]);

  const emlPreviewHtml = useMemo(() => {
    if (!emlPreviewBoxRow) return "";
    return interpolateEmailTemplate(
      emlPreviewBodyDraft,
      emlPreviewBoxRow.interpolationVars,
    );
  }, [emlPreviewBoxRow, emlPreviewBodyDraft]);

  function patchEmlDraftsForPurpose(
    purpose: BoxEmlTemplatePurpose,
    patch: Partial<EmlPurposeDrafts>,
  ) {
    setEmlDraftsByPurpose((prev) => ({
      ...prev,
      [purpose]: { ...prev[purpose], ...patch },
    }));
  }

  async function saveEmlTemplate() {
    const d = emlDraftsByPurpose[emlTemplatePurpose];
    setEmlTemplateSaving(true);
    try {
      const row = await api<BoxEmlTemplateSettings>(
        `/api/house-league/box-eml-template?purpose=${encodeURIComponent(emlTemplatePurpose)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            managed: {
              bodyTemplate: d.managedBody,
              subjectTemplate: d.managedSubject,
            },
            unmanaged: {
              bodyTemplate: d.unmanagedBody,
              subjectTemplate: d.unmanagedSubject,
            },
          }),
        },
      );
      setEmlSavedByPurpose((prev) => ({ ...prev, [emlTemplatePurpose]: row }));
      setEmlDraftsByPurpose((prev) => ({
        ...prev,
        [emlTemplatePurpose]: draftsFromTemplateSettings(row),
      }));
      onLog("Box EML templates saved.");
      void loadEmlBundle();
    } catch (e) {
      onLog(String(e));
    } finally {
      setEmlTemplateSaving(false);
    }
  }

  function resetEmlTemplateDraft() {
    const baseline =
      emlTemplateSaved ??
      (() => {
        const defs = defaultEmlDraftsForPurpose(emlTemplatePurpose);
        return {
          managed: {
            bodyTemplate: defs.managedBody,
            subjectTemplate: defs.managedSubject,
          },
          unmanaged: {
            bodyTemplate: defs.unmanagedBody,
            subjectTemplate: defs.unmanagedSubject,
          },
        };
      })();
    patchEmlDraftsForPurpose(emlTemplatePurpose, draftsFromTemplateSettings(baseline));
    setEmlTemplateEditorResetKey((k) => k + 1);
  }

  function restoreDefaultEmlTemplate() {
    const defs = defaultEmlDraftsForPurpose(emlTemplatePurpose);
    if (emlTemplateEditorTab === "managed") {
      patchEmlDraftsForPurpose(emlTemplatePurpose, {
        managedBody: defs.managedBody,
        managedSubject: defs.managedSubject,
      });
    } else {
      patchEmlDraftsForPurpose(emlTemplatePurpose, {
        unmanagedBody: defs.unmanagedBody,
        unmanagedSubject: defs.unmanagedSubject,
      });
    }
    setEmlTemplateEditorResetKey((k) => k + 1);
  }

  function setEmlActiveBodyDraft(value: string) {
    if (emlTemplateEditorTab === "managed") {
      patchEmlDraftsForPurpose(emlTemplatePurpose, { managedBody: value });
    } else {
      patchEmlDraftsForPurpose(emlTemplatePurpose, { unmanagedBody: value });
    }
  }

  function setEmlActiveSubjectDraft(value: string) {
    if (emlTemplateEditorTab === "managed") {
      patchEmlDraftsForPurpose(emlTemplatePurpose, { managedSubject: value });
    } else {
      patchEmlDraftsForPurpose(emlTemplatePurpose, { unmanagedSubject: value });
    }
  }

  function switchEmlTemplatePurpose(purpose: BoxEmlTemplatePurpose) {
    if (purpose === emlTemplatePurpose) return;
    setEmlTemplatePurpose(purpose);
    if (!emlSavedByPurpose[purpose]) {
      void loadEmlTemplate(purpose);
    }
  }

  function switchEmlTemplateEditorTab(tab: BoxEmlTemplateEditorTab) {
    setEmlTemplateEditorTab(tab);
    if (!emlBundle) return;
    const match = emlBundle.boxes.find((b) =>
      tab === "managed" ? b.managed : !b.managed,
    );
    if (match) setEmlPreviewBox(match.boxNumber);
  }

  async function downloadAllBoxEmlZip() {
    const sid = linkedSeasonId?.trim();
    if (!sid) return;
    const d = emlDraftsByPurpose[emlTemplatePurpose];
    setEmlZipLoading(true);
    try {
      const qs = new URLSearchParams({ purpose: emlTemplatePurpose });
      const path = `/api/seasons/${encodeURIComponent(sid)}/house-league/box-eml.zip?${qs.toString()}`;
      const zipBasename =
        emlTemplatePurpose === "box_modification"
          ? "house-league-box-changes-eml.zip"
          : "house-league-box-eml.zip";
      const payload = {
        purpose: emlTemplatePurpose,
        managed: {
          bodyTemplate: d.managedBody,
          subjectTemplate: d.managedSubject,
        },
        unmanaged: {
          bodyTemplate: d.unmanagedBody,
          subjectTemplate: d.unmanagedSubject,
        },
      };
      if (emlTemplateIsDirty) {
        await downloadBlob(path, zipBasename, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else {
        await downloadBlob(path, zipBasename);
      }
      onLog("Downloaded box EML zip.");
    } catch (e) {
      onLog(String(e));
    } finally {
      setEmlZipLoading(false);
    }
  }

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

  async function approveOutboxRow(id: string) {
    try {
      await api(`/api/email-outbox/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      });
      onLog("Outbox row approved.");
      await loadOutboxList();
    } catch (e) {
      onLog(String(e));
    }
  }

  async function sendOutboxRow(id: string) {
    try {
      const res = await api<{ ok?: boolean; error?: string }>(
        `/api/email-outbox/${encodeURIComponent(id)}/send`,
        { method: "POST" },
      );
      if (res.ok) {
        onLog("Email sent.");
        await loadOutboxList();
      } else {
        onLog(`Send failed: ${res.error ?? "unknown"}`);
      }
    } catch (e) {
      onLog(String(e));
    }
  }

  const toggleOutboxMailSort = useCallback((key: OutboxMailColumnKey) => {
    setOutboxMailSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const outboxFilterUniverses = useMemo(() => {
    const result = {} as Record<OutboxMailColumnKey, string[]>;
    for (const col of OUTBOX_MAIL_COLUMNS) {
      if (col === MAIL_GRID_DATE_SENT_COLUMN_KEY) {
        result[col] = [];
        continue;
      }
      const uniq = new Set<string>();
      for (const row of outboundRows) {
        uniq.add(outboxCellFilterValue(row, col));
      }
      const arr = [...uniq];
      arr.sort((x, y) =>
        x.localeCompare(y, undefined, { sensitivity: "base" }),
      );
      result[col] = arr;
    }
    return result;
  }, [outboundRows]);

  const outboundRowsFilteredSorted = useMemo(() => {
    const filtered = outboundRows.filter((row) =>
      outboxRowPassesColumnFilters(
        row,
        outboxColumnFilters,
        outboxFilterUniverses,
        mailGridDateSentRanges.outbox,
      ),
    );
    return [...filtered].sort((a, b) =>
      compareOutboxMailRows(a, b, outboxMailSort.key, outboxMailSort.dir),
    );
  }, [
    outboundRows,
    outboxColumnFilters,
    outboxFilterUniverses,
    mailGridDateSentRanges.outbox,
    outboxMailSort.key,
    outboxMailSort.dir,
  ]);

  const toggleInboxMailSort = useCallback((key: InboxMailColumnKey) => {
    setInboxMailSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const inboxFilterUniverses = useMemo(() => {
    const result = {} as Record<InboxMailColumnKey, string[]>;
    for (const col of INBOX_MAIL_COLUMNS) {
      if (col === MAIL_GRID_DATE_SENT_COLUMN_KEY) {
        result[col] = [];
        continue;
      }
      const uniq = new Set<string>();
      for (const pair of inboundPairs) {
        uniq.add(inboxCellFilterValue(pair, col));
      }
      const arr = [...uniq];
      arr.sort((x, y) =>
        x.localeCompare(y, undefined, { sensitivity: "base" }),
      );
      result[col] = arr;
    }
    return result;
  }, [inboundPairs]);

  const outboxDateSentFilterActive = useMemo(
    () =>
      !!(
        mailGridDateSentRanges.outbox.from.trim() ||
        mailGridDateSentRanges.outbox.to.trim()
      ),
    [mailGridDateSentRanges.outbox],
  );

  const inboxDateSentFilterActive = useMemo(
    () =>
      !!(
        mailGridDateSentRanges.inbox.from.trim() ||
        mailGridDateSentRanges.inbox.to.trim()
      ),
    [mailGridDateSentRanges.inbox],
  );

  const inboundPairsFilteredSorted = useMemo(() => {
    const filtered = inboundPairs.filter((pair) =>
      inboxRowPassesColumnFilters(
        pair,
        inboxColumnFilters,
        inboxFilterUniverses,
        mailGridDateSentRanges.inbox,
      ),
    );
    return [...filtered].sort((a, b) =>
      compareInboxPairs(a, b, inboxMailSort.key, inboxMailSort.dir),
    );
  }, [
    inboundPairs,
    inboxColumnFilters,
    inboxFilterUniverses,
    mailGridDateSentRanges.inbox,
    inboxMailSort.key,
    inboxMailSort.dir,
  ]);

  function handleOutboxFilterButtonClick(
    col: OutboxMailColumnKey,
    ev: ReactMouseEvent<HTMLButtonElement>,
  ) {
    outboxFilterAnchorRef.current = ev.currentTarget;
    setOutboxFilterRect(ev.currentTarget.getBoundingClientRect());
    setOutboxFilterOpenColumn((prev) => (prev === col ? null : col));
  }

  function handleInboxFilterButtonClick(
    col: InboxMailColumnKey,
    ev: ReactMouseEvent<HTMLButtonElement>,
  ) {
    inboxFilterAnchorRef.current = ev.currentTarget;
    setInboxFilterRect(ev.currentTarget.getBoundingClientRect());
    setInboxFilterOpenColumn((prev) => (prev === col ? null : col));
  }

  return (
    <div className="emails-page">
      {showPageHeading ? <h1>Emails</h1> : null}

      <div
        className="row emails-page-subtablist"
        style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}
        role="tablist"
        aria-label="Email pages"
      >
        <button
          type="button"
          className={subTab === "email" ? "primary" : "secondary"}
          onClick={() => setSubTab("email")}
          role="tab"
          aria-selected={subTab === "email"}
        >
          Email
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
        {showEmlTab ? (
          <button
            type="button"
            className={subTab === "eml" ? "primary" : "secondary"}
            onClick={() => setSubTab("eml")}
            role="tab"
            aria-selected={subTab === "eml"}
          >
            EML files
          </button>
        ) : null}
        {showWeeklyTab ? (
          <button
            type="button"
            className={subTab === "weekly" ? "primary" : "secondary"}
            onClick={() => setSubTab("weekly")}
            role="tab"
            aria-selected={subTab === "weekly"}
          >
            Weekly emails
          </button>
        ) : null}
      </div>

      <div className="emails-page-body">
      {subTab === "eml" && showEmlTab ? (
        <div className="card emails-eml-panel">
          <p style={{ marginTop: 0 }}>
            Generate one Outlook-importable <code>.eml</code> draft per box for the
            linked booking season. Choose the email type, then edit separate templates for
            boxes 1–16 (booked courts) and boxes 17+ (self-scheduled). Each box email is
            rendered from the matching template with roster and schedule placeholders
            filled in. Pick a box to preview, then download all files as a zip.
          </p>
          {emlLoading && !emlBundle ? (
            <p>Loading box emails…</p>
          ) : !emlBundle ? (
            <p>Could not load box EML preview.</p>
          ) : (
            <>
              <div className="emails-eml-meta">
                <p>
                  <strong>{emlBundle.seasonName}</strong> · starts{" "}
                  {emlBundle.seasonStartDateLabel} · {emlBundle.boxes.length}{" "}
                  {emlBundle.boxes.length === 1 ? "box" : "boxes"}
                </p>
              </div>
              {emlBundle.warnings.length > 0 ? (
                <div className="houseleague-banner" role="status" style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" }}>
                  <ul className="emails-eml-warnings">
                    {emlBundle.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="emails-eml-template-panel card">
                <div className="emails-eml-template-toolbar">
                  <div
                    className="emails-eml-template-tabs"
                    role="tablist"
                    aria-label="Box email template variant"
                  >
                    <button
                      type="button"
                      role="tab"
                      className={
                        emlTemplateEditorTab === "managed" ? "is-active" : ""
                      }
                      aria-selected={emlTemplateEditorTab === "managed"}
                      onClick={() => switchEmlTemplateEditorTab("managed")}
                    >
                      Boxes 1–16
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={
                        emlTemplateEditorTab === "unmanaged" ? "is-active" : ""
                      }
                      aria-selected={emlTemplateEditorTab === "unmanaged"}
                      onClick={() => switchEmlTemplateEditorTab("unmanaged")}
                    >
                      Boxes 17+
                    </button>
                  </div>
                  <label className="emails-eml-box-picker emails-eml-purpose-picker">
                    <span className="emails-eml-box-picker-label">Email template</span>
                    <select
                      value={emlTemplatePurpose}
                      onChange={(ev) =>
                        switchEmlTemplatePurpose(
                          ev.target.value as BoxEmlTemplatePurpose,
                        )
                      }
                      aria-label="Box EML email type"
                    >
                      {BOX_EML_TEMPLATE_PURPOSE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="emails-eml-purpose-hint">
                  {emlTemplatePurpose === "season_start"
                    ? "Initial season schedule email sent when the league starts."
                    : "Sent after roster or schedule changes — boxes 1–16 mention updated court bookings; boxes 17+ focus on roster and matchup changes (no pre-booked courts)."}
                </p>
                <div className="emails-eml-preview-editor-head">
                  <span className="emails-eml-preview-editor-label">
                    Email template ·{" "}
                    {emlTemplateEditorTab === "managed"
                      ? "boxes 1–16"
                      : "boxes 17+"}
                    {emlTemplateIsDirty ? (
                      <span className="emails-eml-preview-edited-badge">
                        unsaved
                      </span>
                    ) : null}
                  </span>
                  <div className="emails-eml-template-actions">
                    <button
                      type="button"
                      className="secondary emails-eml-reset-btn"
                      disabled={!emlTemplateIsDirty}
                      onClick={resetEmlTemplateDraft}
                    >
                      Revert changes
                    </button>
                    <button
                      type="button"
                      className="secondary emails-eml-reset-btn"
                      onClick={restoreDefaultEmlTemplate}
                    >
                      Restore default
                    </button>
                    <button
                      type="button"
                      className="primary emails-eml-reset-btn"
                      disabled={emlTemplateSaving || !emlTemplateIsDirty}
                      onClick={() => void saveEmlTemplate()}
                    >
                      {emlTemplateSaving ? "Saving…" : "Save template"}
                    </button>
                  </div>
                </div>
                <label className="emails-eml-subject-template">
                  <span className="emails-eml-box-picker-label">Subject template</span>
                  <input
                    type="text"
                    value={emlActiveSubjectDraft}
                    onChange={(ev) => setEmlActiveSubjectDraft(ev.target.value)}
                    aria-label={
                      emlTemplateEditorTab === "managed"
                        ? "Box EML subject template for boxes 1–16"
                        : "Box EML subject template for boxes 17+"
                    }
                  />
                </label>
                <details className="emails-eml-template-vars">
                  <summary>Template placeholders</summary>
                  <p className="emails-eml-template-vars-lead">
                    Static wording (greeting, section titles, closing sentence, etc.) is
                    edited directly above. Placeholders like{" "}
                    <code>{`{{week1Match1}}`}</code> are filled per box in the preview
                    below.
                  </p>
                  <ul>
                    {BOX_EML_TEMPLATE_VARIABLE_DESCRIPTIONS.map((v) => (
                      <li key={v.key}>
                        <code>{`{{${v.key}}}`}</code> — {v.description}
                      </li>
                    ))}
                  </ul>
                </details>
                <EmlRichTextEditor
                  key={`eml-template-${emlTemplatePurpose}-${emlTemplateEditorTab}-${emlTemplateEditorResetKey}`}
                  html={emlActiveBodyDraft}
                  ariaLabel={
                    emlTemplateEditorTab === "managed"
                      ? "Box EML body template for boxes 1–16"
                      : "Box EML body template for boxes 17+"
                  }
                  onChange={setEmlActiveBodyDraft}
                />
              </div>

              <div className="row emails-eml-toolbar" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
                <label className="emails-eml-box-picker">
                  <span className="emails-eml-box-picker-label">Preview box</span>
                  <select
                    value={emlPreviewBox === "" ? "" : String(emlPreviewBox)}
                    onChange={(ev) => {
                      const v = ev.target.value;
                      setEmlPreviewBox(v === "" ? "" : Number(v));
                    }}
                    aria-label="Box to preview"
                  >
                    {emlBundle.boxes.map((b) => (
                      <option key={b.boxNumber} value={b.boxNumber}>
                        Box {b.boxNumber}
                        {b.managed ? "" : " (self-managed)"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void loadEmlBundle();
                    void loadEmlTemplate(emlTemplatePurpose);
                  }}
                  disabled={emlLoading}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void downloadAllBoxEmlZip()}
                  disabled={emlZipLoading || emlBundle.boxes.length === 0}
                >
                  {emlZipLoading ? "Preparing zip…" : "Download all EML files (.zip)"}
                </button>
              </div>
              {emlPreviewBoxRow ? (
                <div className="emails-eml-preview">
                  <h3 className="emails-eml-preview-heading">Preview for box {emlPreviewBoxRow.boxNumber}</h3>
                  <dl className="emails-eml-preview-meta">
                    <div>
                      <dt>Subject</dt>
                      <dd>{emlPreviewSubject || "—"}</dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>
                        {emlPreviewBoxRow.toAddresses.length > 0
                          ? emlPreviewBoxRow.toAddresses.join(", ")
                          : "— (no emails found)"}
                      </dd>
                    </div>
                    <div>
                      <dt>File</dt>
                      <dd>
                        <code>{emlPreviewBoxRow.filename}</code>
                        {emlPreviewBoxRow.managed
                          ? " · managed schedule"
                          : " · self-managed schedule"}
                      </dd>
                    </div>
                  </dl>
                  {emlPreviewBoxRow.missingEmailPlayers.length > 0 ? (
                    <p className="emails-eml-missing">
                      Missing Club Locker email:{" "}
                      {emlPreviewBoxRow.missingEmailPlayers.join(", ")}
                    </p>
                  ) : null}
                  <div
                    className="emails-eml-preview-body card"
                    dangerouslySetInnerHTML={{ __html: emlPreviewHtml }}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {subTab === "weekly" && showWeeklyTab ? (
        <div className="card weekly-email-stage">
          <div className="weekly-email-tab-toolbar">
            <div
              className="emails-eml-template-tabs weekly-panel-tabs"
              role="tablist"
              aria-label="Weekly emails panel"
            >
              <button
                type="button"
                role="tab"
                className={weeklyPanelView === "preview" ? "is-active" : ""}
                aria-selected={weeklyPanelView === "preview"}
                onClick={() => setWeeklyPanelView("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                role="tab"
                className={weeklyPanelView === "editor" ? "is-active" : ""}
                aria-selected={weeklyPanelView === "editor"}
                onClick={() => setWeeklyPanelView("editor")}
              >
                Email editor
              </button>
              <button
                type="button"
                role="tab"
                className={weeklyPanelView === "from" ? "is-active" : ""}
                aria-selected={weeklyPanelView === "from"}
                onClick={() => setWeeklyPanelView("from")}
              >
                From email
              </button>
            </div>
            <label className="weekly-email-automation-toggle">
              <input
                type="checkbox"
                checked={weeklyFormEnabled}
                onChange={(e) => setWeeklyFormEnabled(e.target.checked)}
              />
              Enable automated Wednesday weekly emails
            </label>
            <div
              className="emails-eml-template-tabs weekly-recipient-mode-tabs"
              role="group"
              aria-label="Weekly email recipient scope"
            >
              <button
                type="button"
                className={weeklyRecipientModeForm === "per_box" ? "is-active" : ""}
                aria-pressed={weeklyRecipientModeForm === "per_box"}
                disabled={weeklySaving}
                onClick={() => void persistWeeklyRecipientMode("per_box")}
              >
                Per box
              </button>
              <button
                type="button"
                className={
                  weeklyRecipientModeForm === "per_matchup" ? "is-active" : ""
                }
                aria-pressed={weeklyRecipientModeForm === "per_matchup"}
                disabled={weeklySaving}
                onClick={() => void persistWeeklyRecipientMode("per_matchup")}
              >
                Per matchup
              </button>
            </div>
          </div>
          <p className="champ-help-small weekly-email-tab-toolbar-help">
            {weeklyRecipientModeForm === "per_matchup"
              ? "One email per pairing (two players per To line). Many more messages than per box."
              : "One email per box (all players in the box on the To line)."}
          </p>

          {weeklyPanelView === "from" ? (
          <div className="card" style={{ marginBottom: "1rem" }}>
            <h3 style={{ marginTop: 0, fontSize: "1rem" }}>Delivery (Outlook .eml)</h3>
            <p className="champ-help-small" style={{ marginTop: 0 }}>
              Used when you download a draft or when messages are sent from the outbox.
              To lines use roster players only; add more From addresses below to switch
              sender.
            </p>
            <div
              className="row"
              style={{ flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.75rem" }}
            >
              <label className="emails-eml-subject-template" style={{ flex: "1", minWidth: "12rem" }}>
                <span className="emails-eml-box-picker-label">From name</span>
                <input
                  type="text"
                  value={weeklyFromName}
                  onChange={(e) => setWeeklyFromName(e.target.value)}
                  autoComplete="name"
                />
              </label>
              <label className="emails-eml-subject-template" style={{ flex: "1", minWidth: "14rem" }}>
                <span className="emails-eml-box-picker-label">From email</span>
                <input
                  type="email"
                  list="weekly-from-email-choices"
                  value={weeklyFromEmail}
                  onChange={(e) => setWeeklyFromEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <datalist id="weekly-from-email-choices">
                  {weeklyFromEmailChoices.map((em) => (
                    <option key={em} value={em} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="champ-test-email-recipients" style={{ marginBottom: "0.75rem" }}>
              <div className="champ-test-email-recipients-label">
                Additional from addresses
              </div>
              {weeklyAlternateFromEmails.length > 0 ? (
                <ul className="champ-test-email-recipient-list">
                  {weeklyAlternateFromEmails.map((em) => (
                    <li key={em} className="champ-test-email-recipient-row">
                      <span className="champ-test-email-recipient-email">{em}</span>
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          em.toLowerCase() === weeklyFromEmail.trim().toLowerCase()
                        }
                        onClick={() => {
                          const prevActive = weeklyFromEmail.trim();
                          if (
                            prevActive &&
                            prevActive.toLowerCase() !== em.toLowerCase()
                          ) {
                            setWeeklyAlternateFromEmails((prev) =>
                              mergeUniqueEmailAddresses(
                                prev.filter(
                                  (x) => x.toLowerCase() !== em.toLowerCase(),
                                ),
                                [prevActive],
                              ),
                            );
                          }
                          setWeeklyFromEmail(em);
                        }}
                      >
                        {em.toLowerCase() === weeklyFromEmail.trim().toLowerCase()
                          ? "Active"
                          : "Use as From"}
                      </button>
                      <button
                        type="button"
                        className="secondary champ-test-email-recipient-remove"
                        aria-label={`Remove ${em}`}
                        onClick={() =>
                          setWeeklyAlternateFromEmails((prev) =>
                            prev.filter((x) => x.toLowerCase() !== em.toLowerCase()),
                          )
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="champ-help-small champ-test-email-recipients-empty">
                  No saved alternates — only the From email above is used.
                </p>
              )}
              <button
                type="button"
                className="secondary"
                style={{ marginTop: "0.5rem" }}
                onClick={openWeeklyAddEmailModal}
              >
                Add another from address…
              </button>
            </div>
          </div>
          ) : null}

          {weeklyPanelView === "from" ? (
          <div className="row" style={{ gap: "0.75rem", marginBottom: "1rem" }}>
            <button
              type="button"
              className="primary"
              disabled={weeklySaving || !weeklySettingsFormDirty}
              onClick={() => void saveWeeklySettings()}
            >
              {weeklySaving ? "Saving…" : "Save settings"}
            </button>
            {weeklySettingsFormDirty ? (
              <span className="emails-eml-preview-edited-badge">unsaved</span>
            ) : null}
          </div>
          ) : null}

          {weeklyPanelView === "editor" ? (
          <div className="emails-eml-template-panel card">
            <div
              className="emails-eml-template-tabs"
              role="tablist"
              aria-label="Weekly email template variant"
            >
              <button
                type="button"
                role="tab"
                className={weeklyTemplateEditorTab === "managed" ? "is-active" : ""}
                aria-selected={weeklyTemplateEditorTab === "managed"}
                onClick={() => setWeeklyTemplateEditorTab("managed")}
              >
                Boxes 1–16
              </button>
              <button
                type="button"
                role="tab"
                className={
                  weeklyTemplateEditorTab === "unmanaged" ? "is-active" : ""
                }
                aria-selected={weeklyTemplateEditorTab === "unmanaged"}
                onClick={() => setWeeklyTemplateEditorTab("unmanaged")}
              >
                Boxes 17+
              </button>
            </div>
            <div className="emails-eml-preview-editor-head">
              <span className="emails-eml-preview-editor-label">
                {weeklyRecipientModeForm === "per_matchup"
                  ? "Matchup template"
                  : "Box template"}{" "}
                · {weeklyTemplateEditorTab === "managed" ? "boxes 1–16" : "boxes 17+"}
                {weeklyTemplateIsDirty ? (
                  <span className="emails-eml-preview-edited-badge">unsaved</span>
                ) : null}
              </span>
              <div className="emails-eml-template-actions">
                <button
                  type="button"
                  className="secondary emails-eml-reset-btn"
                  disabled={!weeklyTemplateIsDirty}
                  onClick={resetWeeklyTemplateDraft}
                >
                  Revert changes
                </button>
                <button
                  type="button"
                  className="secondary emails-eml-reset-btn"
                  onClick={restoreDefaultWeeklyTemplate}
                >
                  Restore default
                </button>
                <button
                  type="button"
                  className="primary emails-eml-reset-btn"
                  disabled={weeklyTemplateSaving || !weeklyTemplateIsDirty}
                  onClick={() => void saveWeeklyTemplate()}
                >
                  {weeklyTemplateSaving ? "Saving…" : "Save template"}
                </button>
              </div>
            </div>
            <label className="emails-eml-subject-template">
              <span className="emails-eml-box-picker-label">Subject template</span>
              <input
                type="text"
                value={weeklyActiveSubjectDraft}
                onChange={(ev) => setWeeklyActiveSubjectDraft(ev.target.value)}
              />
            </label>
            <details className="emails-eml-template-vars">
              <summary>Template placeholders</summary>
              <ul>
                {weeklyActiveTemplateVars.map((v) => (
                  <li key={v.key}>
                    <code>{`{{${v.key}}}`}</code> — {v.description}
                  </li>
                ))}
              </ul>
            </details>
            <EmlRichTextEditor
              key={`weekly-template-${weeklyRecipientModeForm}-${weeklyTemplateEditorTab}-${weeklyTemplateEditorResetKey}`}
              html={weeklyActiveBodyDraft}
              ariaLabel="Weekly email body template"
              onChange={setWeeklyActiveBodyDraft}
            />
          </div>
          ) : null}

          {weeklyPanelView === "preview" ? (
          <>
          <p className="champ-help-small weekly-preview-toolbar-help">
            Pick a message to preview, or download every draft{" "}
            <code>.eml</code> for this week as a zip (same row as Week).
          </p>
          <div className="row emails-eml-toolbar weekly-preview-toolbar">
            <label className="emails-eml-box-picker">
              <span className="emails-eml-box-picker-label">Week</span>
              <select
                value={weeklyWeek === "" ? "" : String(weeklyWeek)}
                onChange={(ev) => {
                  const v = ev.target.value;
                  setWeeklyWeek(v === "" ? "" : Number(v));
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                  <option key={w} value={w}>
                    Week {w}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={weeklyLoading}
              onClick={() => void loadWeeklyBundle()}
            >
              Refresh preview
            </button>
            <button
              type="button"
              className="secondary weekly-preview-zip-btn"
              disabled={
                weeklyZipLoading ||
                weeklyWeek === "" ||
                weeklyExportableCount === 0 ||
                !weeklyZipFromEmail
              }
              title={
                !weeklyZipFromEmail
                  ? "Set From email on the From email tab"
                  : weeklyExportableCount === 0
                    ? "No messages to export for this week"
                    : "Download all draft .eml files for this week"
              }
              onClick={() => void downloadAllWeeklyEmlZip()}
            >
              {weeklyZipLoading
                ? "Preparing zip…"
                : "Download all EML files (.zip)"}
            </button>
            <span className="weekly-preview-toolbar-spacer" aria-hidden />
            <button
              type="button"
              className="primary"
              disabled={weeklySendLoading || weeklyWeek === ""}
              onClick={() => void sendWeeklyWeek(false)}
            >
              {weeklySendLoading ? "Sending…" : "Send week now"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={weeklySendLoading || weeklyWeek === ""}
              onClick={() => void sendWeeklyWeek(true)}
            >
              Force resend
            </button>
          </div>

          {weeklyLoading && !weeklyBundle ? (
            <p>Loading preview…</p>
          ) : !weeklyBundle ? (
            <p>Could not load weekly preview.</p>
          ) : (
            <>
              <p className="weekly-preview-title">
                <strong>{weeklyBundle.seasonName}</strong> · week{" "}
                {weeklyBundle.weekNumber}
                {weeklyBundle.weekPlayDateLabel
                  ? ` · ${weeklyBundle.weekPlayDateLabel}`
                  : ""}
                {weeklyBundle.managedWeekConverted
                  ? " · managed bookings ready"
                  : " · managed bookings not ready"}
              </p>
              {weeklyBundle.warnings.length > 0 ? (
                <ul className="emails-eml-warnings">
                  {weeklyBundle.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
              <p className="champ-help-small" style={{ margin: "0 0 0.5rem" }}>
                {weeklyBundle.items.length} message
                {weeklyBundle.items.length === 1 ? "" : "s"} ·{" "}
                {weeklyBundle.recipientMode === "per_matchup"
                  ? "per matchup"
                  : "per box"}
              </p>
              <label className="emails-eml-box-picker">
                <span className="emails-eml-box-picker-label">Preview message</span>
                <select
                  value={weeklyPreviewItemKey}
                  onChange={(ev) => setWeeklyPreviewItemKey(ev.target.value)}
                >
                  {weeklyBundle.items.map((item) => (
                    <option key={item.itemKey} value={item.itemKey}>
                      {item.label}
                      {item.skippedReason ? ` (${item.skippedReason})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {weeklyPreviewItem ? (
                <div className="emails-eml-preview">
                  <dl className="emails-eml-preview-meta">
                    <div>
                      <dt>Subject</dt>
                      <dd>{weeklyPreviewItem.subject || "—"}</dd>
                    </div>
                    <div>
                      <dt>From</dt>
                      <dd>
                        {weeklyFromName.trim()
                          ? `${weeklyFromName.trim()} <${weeklyFromEmail.trim() || "—"}>`
                          : weeklyFromEmail.trim() || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>
                        {weeklyPreviewItem.toAddresses.length > 0
                          ? weeklyPreviewItem.toAddresses.join(", ")
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>File</dt>
                      <dd>
                        <code>
                          {weeklyWeek !== ""
                            ? weeklyPreviewItem.recipientKind === "matchup"
                              ? weeklyMatchupEmlFilename(
                                  weeklyPreviewItem.boxNumber,
                                  weeklyWeek,
                                  weeklyPreviewItem.matchIndex,
                                )
                              : weeklyBoxEmlFilename(
                                  weeklyPreviewItem.boxNumber,
                                  weeklyWeek,
                                )
                            : "—"}
                        </code>
                      </dd>
                    </div>
                    {weeklyPreviewItem.skippedReason ? (
                      <div>
                        <dt>Skipped</dt>
                        <dd>{weeklyPreviewItem.skippedReason}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="row" style={{ gap: "0.75rem", marginBottom: "0.75rem" }}>
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        !weeklyPreviewItem.htmlBody ||
                        Boolean(weeklyPreviewItem.skippedReason) ||
                        weeklyWeek === ""
                      }
                      onClick={downloadWeeklyPreviewEml}
                    >
                      Download .eml
                    </button>
                  </div>
                  {weeklyPreviewItem.htmlBody ? (
                    <div
                      className="emails-eml-preview-body card"
                      dangerouslySetInnerHTML={{
                        __html: weeklyPreviewItem.htmlBody,
                      }}
                    />
                  ) : (
                    <p>No preview (message skipped).</p>
                  )}
                </div>
              ) : null}
            </>
          )}
          </>
          ) : null}
        </div>
      ) : null}

      {subTab === "schedule" && showScheduleTab ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Optional <strong>per-player</strong> reminders a few days before each booked
            match (separate from the Wednesday weekly box emails on the Weekly emails
            tab). Sends use the automation scheduler and <code>email_outbox</code>.
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
                Enable per-player match reminders
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

      {subTab === "email" ? (
        <div className="card emails-mail-panel">
          <div
            className="emails-nested-tablist row"
            role="tablist"
            aria-label="Inbox or outbox"
          >
            <button
              type="button"
              className={
                emailPanelTab === "outbox" ? "primary" : "secondary"
              }
              onClick={() => setEmailPanelTab("outbox")}
              role="tab"
              aria-selected={emailPanelTab === "outbox"}
            >
              Outbox
            </button>
            <button
              type="button"
              className={
                emailPanelTab === "inbox" ? "primary" : "secondary"
              }
              onClick={() => setEmailPanelTab("inbox")}
              role="tab"
              aria-selected={emailPanelTab === "inbox"}
            >
              Inbox
            </button>
            <button
              type="button"
              className="secondary emails-mail-refresh-btn"
              disabled={mailLoading}
              aria-label={mailLoading ? "Refreshing" : "Refresh list"}
              title="Refresh"
              onClick={() =>
                void (emailPanelTab === "outbox"
                  ? loadOutboxList()
                  : loadInboxList())
              }
            >
              <RefreshCw size={18} strokeWidth={2} aria-hidden />
            </button>
          </div>

          {mailLoading ? (
            <p>Loading…</p>
          ) : emailPanelTab === "outbox" ? (
            <>
              <div className="houseleague-table-wrap">
                <table className="houseleague-table emails-mail-table">
                  <thead>
                    <tr>
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label={MAIL_GRID_DATE_COLUMN_LABEL}
                        column={MAIL_GRID_DATE_SENT_COLUMN_KEY}
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={outboxDateSentFilterActive}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick(
                            MAIL_GRID_DATE_SENT_COLUMN_KEY,
                            ev,
                          )
                        }
                      />
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label="Status"
                        column="status"
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={!!outboxColumnFilters.status}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick("status", ev)
                        }
                      />
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label="Kind"
                        column="kind"
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={!!outboxColumnFilters.kind}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick("kind", ev)
                        }
                      />
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label="To"
                        column="toAddress"
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={!!outboxColumnFilters.toAddress}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick("toAddress", ev)
                        }
                      />
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label="Subject"
                        column="subject"
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={!!outboxColumnFilters.subject}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick("subject", ev)
                        }
                      />
                      <MailSortFilterTh<OutboxMailColumnKey>
                        label="Actions"
                        column="actions"
                        sortKey={outboxMailSort.key}
                        sortDir={outboxMailSort.dir}
                        onSort={toggleOutboxMailSort}
                        filterActive={!!outboxColumnFilters.actions}
                        onFilterClick={(ev) =>
                          handleOutboxFilterButtonClick("actions", ev)
                        }
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {outboundRows.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          No rows yet. Scheduled reminders and other sends use{" "}
                          <code>email_outbox</code>.
                        </td>
                      </tr>
                    ) : outboundRowsFilteredSorted.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          No rows match the current column filters.
                        </td>
                      </tr>
                    ) : (
                      outboundRowsFilteredSorted.map((row) => {
                        const whenIso = outboxWhenIso(row);
                        return (
                          <tr key={row.id}>
                            <td>
                              <time dateTime={whenIso}>
                                {formatMailDateSentLabel(whenIso)}
                              </time>
                            </td>
                            <td>{row.status}</td>
                            <td>
                              <code>{row.kind}</code>
                            </td>
                            <td
                              className="emails-mail-cell-clip"
                              title={row.toAddress}
                            >
                              {row.toAddress}
                            </td>
                            <td
                              className="emails-mail-cell-clip"
                              title={row.subject}
                            >
                              {row.subject}
                            </td>
                            <td className="emails-mail-actions">
                              {row.status === "draft" ? (
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() =>
                                    void approveOutboxRow(row.id)
                                  }
                                >
                                  Approve
                                </button>
                              ) : null}
                              {row.status === "approved" ? (
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => void sendOutboxRow(row.id)}
                                >
                                  Send
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {outboxFilterOpenColumn === MAIL_GRID_DATE_SENT_COLUMN_KEY &&
              outboxFilterRect ? (
                <EmailMailDateRangeFilterPopover
                  rect={outboxFilterRect}
                  from={mailGridDateSentRanges.outbox.from}
                  to={mailGridDateSentRanges.outbox.to}
                  anchorRef={outboxFilterAnchorRef}
                  onChange={(next) =>
                    setMailGridDateSentRanges((r) => ({
                      ...r,
                      outbox: next,
                    }))
                  }
                  onClose={() => setOutboxFilterOpenColumn(null)}
                />
              ) : outboxFilterOpenColumn !== null &&
                outboxFilterOpenColumn !== MAIL_GRID_DATE_SENT_COLUMN_KEY &&
                outboxFilterRect ? (
                <EmailColumnFilterPopover
                  rect={outboxFilterRect}
                  universe={
                    outboxFilterUniverses[outboxFilterOpenColumn] ?? []
                  }
                  selection={outboxColumnFilters[outboxFilterOpenColumn]}
                  anchorRef={outboxFilterAnchorRef}
                  onChange={(next) => {
                    setOutboxColumnFilters((f) => {
                      const nf = { ...f };
                      const col = outboxFilterOpenColumn;
                      if (!col) return f;
                      if (next === undefined) delete nf[col];
                      else nf[col] = next;
                      return nf;
                    });
                  }}
                  onClose={() => setOutboxFilterOpenColumn(null)}
                />
              ) : null}
            </>
          ) : (
            <>
              <div className="houseleague-table-wrap">
                <table className="houseleague-table emails-mail-table">
                  <thead>
                    <tr>
                      <MailSortFilterTh<InboxMailColumnKey>
                        label={MAIL_GRID_DATE_COLUMN_LABEL}
                        column={MAIL_GRID_DATE_SENT_COLUMN_KEY}
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={inboxDateSentFilterActive}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick(
                            MAIL_GRID_DATE_SENT_COLUMN_KEY,
                            ev,
                          )
                        }
                      />
                      <MailSortFilterTh<InboxMailColumnKey>
                        label="From"
                        column="fromAddress"
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={!!inboxColumnFilters.fromAddress}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick("fromAddress", ev)
                        }
                      />
                      <MailSortFilterTh<InboxMailColumnKey>
                        label="To"
                        column="toAddress"
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={!!inboxColumnFilters.toAddress}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick("toAddress", ev)
                        }
                      />
                      <MailSortFilterTh<InboxMailColumnKey>
                        label="Tag"
                        column="tag"
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={!!inboxColumnFilters.tag}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick("tag", ev)
                        }
                      />
                      <MailSortFilterTh<InboxMailColumnKey>
                        label="Subject"
                        column="subject"
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={!!inboxColumnFilters.subject}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick("subject", ev)
                        }
                      />
                      <MailSortFilterTh<InboxMailColumnKey>
                        label="Action"
                        column="action"
                        sortKey={inboxMailSort.key}
                        sortDir={inboxMailSort.dir}
                        onSort={toggleInboxMailSort}
                        filterActive={!!inboxColumnFilters.action}
                        onFilterClick={(ev) =>
                          handleInboxFilterButtonClick("action", ev)
                        }
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {inboundPairs.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          No inbound messages recorded. The IMAP poller stores rows in{" "}
                          <code>inbound_emails</code> when UNSEEN mail is fetched.
                        </td>
                      </tr>
                    ) : inboundPairsFilteredSorted.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          No rows match the current column filters.
                        </td>
                      </tr>
                    ) : (
                      inboundPairsFilteredSorted.map((pair) => {
                        const { email: em, action: act } = pair;
                        const whenIso = inboxWhenIso(pair);
                        return (
                        <tr key={em.id}>
                          <td>
                            <time dateTime={whenIso}>
                              {formatMailDateSentLabel(whenIso)}
                            </time>
                          </td>
                          <td
                            className="emails-mail-cell-clip"
                            title={em.fromAddress}
                          >
                            {em.fromAddress}
                          </td>
                          <td
                            className="emails-mail-cell-clip"
                            title={em.toAddress}
                          >
                            {em.toAddress}
                          </td>
                          <td>
                            {em.mailboxScope ? (
                              <code>{em.mailboxScope}</code>
                            ) : em.aliasTag ? (
                              <code>{em.aliasTag}</code>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td
                            className="emails-mail-cell-clip"
                            title={em.subject ?? ""}
                          >
                            {em.subject ?? "—"}
                          </td>
                          <td>
                            {act ? (
                              <span>
                                <code>{act.kind}</code>
                                <span className="emails-mail-pill">{act.status}</span>
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {inboxFilterOpenColumn === MAIL_GRID_DATE_SENT_COLUMN_KEY &&
              inboxFilterRect ? (
                <EmailMailDateRangeFilterPopover
                  rect={inboxFilterRect}
                  from={mailGridDateSentRanges.inbox.from}
                  to={mailGridDateSentRanges.inbox.to}
                  anchorRef={inboxFilterAnchorRef}
                  onChange={(next) =>
                    setMailGridDateSentRanges((r) => ({
                      ...r,
                      inbox: next,
                    }))
                  }
                  onClose={() => setInboxFilterOpenColumn(null)}
                />
              ) : inboxFilterOpenColumn !== null &&
                  inboxFilterOpenColumn !== MAIL_GRID_DATE_SENT_COLUMN_KEY &&
                  inboxFilterRect ? (
                <EmailColumnFilterPopover
                  rect={inboxFilterRect}
                  universe={
                    inboxFilterUniverses[inboxFilterOpenColumn] ?? []
                  }
                  selection={inboxColumnFilters[inboxFilterOpenColumn]}
                  anchorRef={inboxFilterAnchorRef}
                  onChange={(next) => {
                    setInboxColumnFilters((f) => {
                      const nf = { ...f };
                      const col = inboxFilterOpenColumn;
                      if (!col) return f;
                      if (next === undefined) delete nf[col];
                      else nf[col] = next;
                      return nf;
                    });
                  }}
                  onClose={() => setInboxFilterOpenColumn(null)}
                />
              ) : null}
            </>
          )}
        </div>
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

      {weeklyAddEmailModalOpen ? (
        <div
          className="champ-test-email-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setWeeklyAddEmailModalOpen(false);
          }}
        >
          <div
            className="champ-test-email-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weekly-add-email-title"
          >
            <h3 id="weekly-add-email-title">Add from address</h3>
            <p className="champ-help-small" style={{ marginTop: 0 }}>
              Saved as an alternate sender and set as the active From address. Use
              “Use as From” on the From email tab to switch later.
            </p>
            <div className="champ-test-email-field">
              <label htmlFor="weekly-add-email-input">Email address</label>
              <input
                id="weekly-add-email-input"
                type="email"
                autoComplete="email"
                value={weeklyAddEmailInput}
                onChange={(e) => setWeeklyAddEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitWeeklyAddEmail();
                  }
                }}
              />
            </div>
            <div className="champ-test-email-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setWeeklyAddEmailModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={commitWeeklyAddEmail}
              >
                Add
              </button>
            </div>
          </div>
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
    </div>
  );
}
