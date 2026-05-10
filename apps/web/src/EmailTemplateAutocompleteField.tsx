import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEventHandler,
} from "react";
import { EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS } from "@squash/shared";

/**
 * If the cursor sits inside an unfinished `{{…}` or a `{…}` after a single `{`,
 * returns the range to replace with a full `{{variable}}` token.
 */
export function matchEmailVariableAutocomplete(
  text: string,
  cursor: number,
): { replaceFrom: number; replaceTo: number; query: string } | null {
  const before = text.slice(0, cursor);
  let m = before.match(/\{\{([\w]*)$/);
  if (m?.index !== undefined) {
    return {
      replaceFrom: m.index,
      replaceTo: cursor,
      query: m[1] ?? "",
    };
  }
  m = before.match(/(?<!\{)\{([\w]*)$/);
  if (m?.index !== undefined) {
    return {
      replaceFrom: m.index,
      replaceTo: cursor,
      query: m[1] ?? "",
    };
  }
  return null;
}

export type EmailTemplateAutocompleteFieldProps = {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
  required?: boolean;
  id?: string;
  autoComplete?: string;
  /**
   * When this changes (e.g. switching loaded template rows), the popup closes.
   * Avoid keys that change every keystroke — that would dismiss the menu while typing.
   */
  autocompleteIdentityKey?: string;
};

export function EmailTemplateAutocompleteField({
  value,
  onChange,
  disabled,
  multiline,
  rows = 8,
  required,
  id,
  autoComplete,
  autocompleteIdentityKey,
}: EmailTemplateAutocompleteFieldProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  function activeField(): HTMLInputElement | HTMLTextAreaElement | null {
    return multiline ? taRef.current : inputRef.current;
  }

  const [menu, setMenu] = useState<{
    replaceFrom: number;
    replaceTo: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = (menu?.query ?? "").trim().toLowerCase();
    return EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS.filter((v) => {
      if (!q) return true;
      return (
        v.key.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q)
      );
    });
  }, [menu]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [menu?.query]);

  useEffect(() => {
    setMenu(null);
  }, [autocompleteIdentityKey]);

  const close = useCallback(() => setMenu(null), []);

  const updateMenuFromElement = useCallback(
    (el: HTMLTextAreaElement | HTMLInputElement) => {
      if (disabled) {
        setMenu(null);
        return;
      }
      const v = el.value;
      const cursor = el.selectionStart ?? v.length;
      setMenu(matchEmailVariableAutocomplete(v, cursor));
    },
    [disabled],
  );

  const applyVariable = useCallback(
    (key: string) => {
      if (!menu) return;
      const el = activeField();
      if (!el) return;
      const v = el.value;
      const next =
        v.slice(0, menu.replaceFrom) + `{{${key}}}` + v.slice(menu.replaceTo);
      onChange(next);
      close();
      const caret = menu.replaceFrom + key.length + 4;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [menu, multiline, onChange, close],
  );

  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const el = e.target;
    onChange(el.value);
    updateMenuFromElement(el);
  };

  function handleSelectForCaret(
    ev: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    updateMenuFromElement(ev.currentTarget);
  }

  const safeHl =
    filtered.length === 0
      ? 0
      : Math.min(highlightIndex, filtered.length - 1);

  const handleKeyDown: KeyboardEventHandler<
    HTMLInputElement | HTMLTextAreaElement
  > = (ev) => {
    if (!menu) return;

    const hasList = filtered.length > 0;
    switch (ev.key) {
      case "Escape":
        ev.preventDefault();
        close();
        return;
      case "ArrowDown":
        if (hasList) {
          ev.preventDefault();
          setHighlightIndex((i) =>
            Math.min(filtered.length - 1, i + 1),
          );
        }
        return;
      case "ArrowUp":
        if (hasList) {
          ev.preventDefault();
          setHighlightIndex((i) => Math.max(0, i - 1));
        }
        return;
      case "Enter":
      case "Tab":
        if (hasList) {
          ev.preventDefault();
          const idx = Math.min(highlightIndex, filtered.length - 1);
          applyVariable(filtered[idx]!.key);
        }
        return;
      default:
        break;
    }
  };

  useEffect(() => {
    const li = listRef.current?.querySelector(`[data-ac-idx="${safeHl}"]`);
    li?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, safeHl, filtered.length, menu]);

  const commonProps = {
    value,
    onChange: handleChange,
    onSelect: handleSelectForCaret,
    onClick: (
      e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      updateMenuFromElement(e.currentTarget);
    },
    onKeyUp: (
      e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      if (
        ["ArrowLeft", "ArrowRight", "Home", "End", "Backspace"].includes(e.key)
      )
        updateMenuFromElement(e.currentTarget);
    },
    disabled,
    id,
    autoComplete: autoComplete ?? "off",
    "aria-autocomplete": menu ? ("list" as const) : undefined,
    "aria-expanded": Boolean(menu),
    onKeyDown: handleKeyDown,
  };

  return (
    <span className="email-var-ac-root">
      {multiline ? (
        <textarea ref={taRef} {...commonProps} rows={rows} required={required} />
      ) : (
        <input
          ref={inputRef}
          type="text"
          {...commonProps}
          required={required}
        />
      )}
      {menu ? (
        <div className="email-var-ac-dropdown" role="presentation">
          {filtered.length === 0 ? (
            <div className="email-var-ac-empty">
              No variables match “{menu.query}”.
            </div>
          ) : (
            <>
              <div className="email-var-ac-hint" id={`${id ?? "mail-ac"}-hint`}>
                Variables — ↑↓ navigate, Enter to insert
              </div>
              <ul
                ref={listRef}
                className="email-var-ac-list"
                role="listbox"
                aria-label="Email template variables"
              >
                {filtered.map((v, i) => (
                  <li key={v.key} role="presentation">
                    <button
                      type="button"
                      tabIndex={-1}
                      data-ac-idx={i}
                      role="option"
                      aria-selected={i === safeHl}
                      className={
                        i === safeHl
                          ? "email-var-ac-item email-var-ac-item--active"
                          : "email-var-ac-item"
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyVariable(v.key);
                      }}
                      onMouseEnter={() => setHighlightIndex(i)}
                    >
                      <code className="email-var-ac-key">{`{{${v.key}}}`}</code>
                      <span className="email-var-ac-desc">{v.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}
