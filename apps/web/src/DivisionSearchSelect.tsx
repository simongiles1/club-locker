import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  divisionCode,
  divisionDisplayName,
  type ChampionshipDivision,
} from "@squash/shared";

/** Same popover/blur behaviour as MemberSearchSelect. */
function divisionPickMouseDown(e: MouseEvent<HTMLDivElement>) {
  e.preventDefault();
}

export function DivisionSearchSelect({
  idPrefix,
  label,
  divisions,
  selectedCode,
  createdCodes,
  onSelectCode,
  disabled,
}: {
  idPrefix: string;
  label: string;
  divisions: ChampionshipDivision[];
  selectedCode: string;
  createdCodes: ReadonlySet<string>;
  onSelectCode: (code: string) => void;
  disabled?: boolean;
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

  const selectedDivision = useMemo(
    () => divisions.find((d) => divisionCode(d) === selectedCode) ?? null,
    [divisions, selectedCode],
  );

  useEffect(() => {
    setQuery("");
  }, [selectedCode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return divisions.filter((d) => {
      if (!q) return true;
      const name = divisionDisplayName(d).toLowerCase();
      const cd = divisionCode(d);
      return name.includes(q) || cd.includes(q);
    });
  }, [divisions, query]);

  function handlePick(code: string) {
    onSelectCode(code);
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
      {selectedDivision != null ? (
        <div
          className="member-picker-selected"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="member-picker-selected-name">
            {divisionDisplayName(selectedDivision)}
          </span>
        </div>
      ) : null}
      <input
        id={`${idPrefix}-search`}
        type="search"
        className="member-picker-search"
        placeholder={
          selectedDivision != null
            ? "Search to change…"
            : "Search divisions…"
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
          onMouseDown={divisionPickMouseDown}
        >
          <div className="member-picker-list" role="listbox" aria-labelledby={headingId}>
            {filtered.map((d) => {
              const code = divisionCode(d);
              const selected = selectedCode === code;
              const created = createdCodes.has(code);
              return (
                <button
                  key={code}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  className={`member-picker-option${selected ? " is-selected" : ""}`}
                  onClick={() => handlePick(code)}
                >
                  <span className="member-picker-name">
                    {divisionDisplayName(d)}
                  </span>
                  <span className="member-picker-email">
                    {created ? "Created" : ""}
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
