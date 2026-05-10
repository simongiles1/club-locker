import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from "react";
import type { ClubMember } from "./MembersPage.js";

export function clubMemberDisplayName(m: ClubMember): string {
  return `${m.firstName} ${m.lastName}`.trim();
}

/** Keeps focus on the search input so mousedown on an option still fires click (popover blur race). */
function memberPickMouseDown(e: MouseEvent<HTMLDivElement>) {
  e.preventDefault();
}

export function MemberSearchSelect({
  idPrefix,
  label,
  members,
  excludedSsmIds,
  valueSsmId,
  onChange,
  disabled,
  commitOnSelect,
  onCommit,
  inputRef,
}: {
  idPrefix: string;
  label: string;
  members: ClubMember[];
  excludedSsmIds: Set<number>;
  valueSsmId: number | null;
  onChange: (ssmId: number | null) => void;
  disabled?: boolean;
  /** When true, choosing a member row calls `onCommit(ssmId)` and closes (add-to-roster flow). */
  commitOnSelect?: boolean;
  onCommit?: (ssmId: number) => void;
  /** Focus management for adjacent fields (e.g. focus partner after primary select). */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = `${idPrefix}-listbox`;
  const headingId = `${idPrefix}-heading`;

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 200);
  }, [cancelScheduledClose]);

  const selectedMember = useMemo(() => {
    if (valueSsmId == null) return null;
    return members.find((m) => m.ssmId === valueSsmId) ?? null;
  }, [members, valueSsmId]);

  useEffect(() => {
    setQuery("");
  }, [valueSsmId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => !excludedSsmIds.has(m.ssmId))
      .filter((m) => {
        if (!q) return true;
        const name = `${m.firstName} ${m.lastName}`.toLowerCase();
        const email = (m.email ?? "").toLowerCase();
        const phone = [m.cellPhone, m.workPhone, m.homePhone]
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .join(" ")
          .toLowerCase();
        const custom = (m.customId ?? "").toLowerCase();
        return (
          name.includes(q) ||
          email.includes(q) ||
          phone.includes(q) ||
          custom.includes(q) ||
          String(m.ssmId).includes(q)
        );
      })
      .sort((a, b) =>
        a.lastName.localeCompare(b.lastName, undefined, {
          sensitivity: "base",
        }),
      );
  }, [members, excludedSsmIds, query]);

  function handlePickMember(ssmId: number) {
    if (commitOnSelect && onCommit) {
      onCommit(ssmId);
      setQuery("");
      cancelScheduledClose();
      setOpen(false);
      return;
    }
    onChange(ssmId);
    setQuery("");
    cancelScheduledClose();
    setOpen(false);
  }

  function handleClearSelection() {
    onChange(null);
    setQuery("");
    cancelScheduledClose();
    setOpen(false);
  }

  return (
    <div
      className={`member-search-select${open ? " member-search-select--open" : ""}`}
    >
      <div id={headingId} className="member-picker-heading">
        {label}
      </div>
      {!commitOnSelect && valueSsmId != null ? (
        <div
          className="member-picker-selected"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="member-picker-selected-name">
            {selectedMember
              ? clubMemberDisplayName(selectedMember)
              : `Member #${valueSsmId}`}
          </span>
          <button
            type="button"
            className="member-picker-selected-clear"
            disabled={disabled}
            aria-label={`Clear ${label}`}
            onClick={() => {
              handleClearSelection();
            }}
          >
            Clear
          </button>
        </div>
      ) : null}
      <input
        ref={inputRef}
        id={`${idPrefix}-search`}
        type="search"
        className="member-picker-search"
        placeholder={
          !commitOnSelect && valueSsmId != null
            ? "Search to change…"
            : "Search name, email, phone..."
        }
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          cancelScheduledClose();
          setOpen(true);
        }}
        onBlur={() => scheduleClose()}
        autoComplete="off"
        aria-labelledby={headingId}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open ? (
        <div
          id={listboxId}
          className="member-picker-popover"
          role="presentation"
          onMouseDown={memberPickMouseDown}
        >
          <div className="member-picker-list" role="listbox" aria-labelledby={headingId}>
            {!commitOnSelect ? (
              <button
                type="button"
                role="option"
                aria-selected={valueSsmId === null}
                disabled={disabled}
                className={`member-picker-option member-picker-option--placeholder${valueSsmId === null ? " is-selected" : ""}`}
                onClick={handleClearSelection}
              >
                <span className="member-picker-name">Select…</span>
              </button>
            ) : null}
            {filtered.map((m) => {
              const selected = valueSsmId === m.ssmId;
              const email = (m.email ?? "").trim();
              return (
                <button
                  key={m.ssmId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  className={`member-picker-option${selected ? " is-selected" : ""}`}
                  onClick={() => handlePickMember(m.ssmId)}
                >
                  <span className="member-picker-name">{clubMemberDisplayName(m)}</span>
                  <span className="member-picker-email" title={email || undefined}>
                    {email || "—"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
