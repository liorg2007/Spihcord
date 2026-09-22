import { dismissToast, useApp } from "../store/app";
import { XIcon } from "./Icons";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span>{t.message}</span>
          <button className="icon-btn small" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <XIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
