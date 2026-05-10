import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "info" | "error";

type ToastRow = { id: string; message: string; kind: ToastKind };

const ToastCtx = createContext<
  null | ((message: string, kind: ToastKind) => void)
>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<ToastRow[]>([]);

  const push = useCallback((message: string, kind: ToastKind) => {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());
    setRows((r) => [...r, { id, message, kind }]);
    window.setTimeout(() => {
      setRows((r) => r.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {rows.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.kind}`}
            role="status"
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  if (!push) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return useMemo(
    () => ({
      show: (message: string) => push(message, "info"),
      error: (message: string) => push(message, "error"),
    }),
    [push],
  );
}
