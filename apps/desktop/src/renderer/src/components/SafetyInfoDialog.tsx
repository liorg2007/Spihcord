import { useEffect } from "react";
import { create } from "zustand";
import { ShieldIcon } from "./Icons";

const useSafetyInfo = create<{ open: boolean }>()(() => ({ open: false }));

export function openSafetyInfo(): void {
  useSafetyInfo.setState({ open: true });
}
function closeSafetyInfo(): void {
  useSafetyInfo.setState({ open: false });
}

/** Plain-language explainer for safety numbers and verification. */
export function SafetyInfoDialog() {
  const open = useSafetyInfo((s) => s.open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSafetyInfo();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="About safety numbers" onMouseDown={closeSafetyInfo}>
      <div className="modal" style={{ width: "min(440px, calc(100vw - 32px))" }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldIcon size={20} /> Safety numbers
          </h2>
        </header>
        <div style={{ padding: "4px 20px 16px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", minHeight: 0 }}>
          <p style={{ margin: 0 }}>
            Calls are end-to-end encrypted. Each install has its own security key, and the safety number is built from
            your key and theirs, so you both see the same number.
          </p>
          <p style={{ margin: 0 }}>
            <strong>To verify:</strong> compare the number with them in person or over another app (not this call). If
            it matches, nobody is intercepting your calls. Mark them as verified and a green shield appears on their
            tile.
          </p>
          <p style={{ margin: 0 }}>
            If their key ever changes you'll be warned, and no audio or video is exchanged until you decide. A reinstall,
            a new device or a cleared app profile also changes the key.
          </p>
        </div>
        <footer className="modal-foot">
          <button className="btn btn-primary" onClick={closeSafetyInfo}>
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
