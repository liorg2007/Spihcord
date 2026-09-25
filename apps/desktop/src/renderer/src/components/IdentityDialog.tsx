import { useEffect, useState } from "react";
import { safetyNumber, useIdentity } from "../lib/identity";
import { disconnectOnIdentityMismatch, trustNewIdentity } from "../lib/voice";
import { displayNameOf, useApp } from "../store/app";
import { WarningIcon } from "./Icons";

/**
 * Shown when a peer in our call presents a DTLS key that differs from the one
 * pinned for them. The engine keeps that connection blocked (no media) until
 * the user picks "Trust new key" or "Disconnect"; there is no dismiss.
 */
export function IdentityDialog() {
  const m = useIdentity((s) => s.mismatches[0]);
  const users = useApp((s) => s.users);
  const [sn, setSn] = useState<string | null>(null);

  useEffect(() => {
    setSn(null);
    if (!m || m.reason !== "changed") return;
    let live = true;
    void safetyNumber(m.received).then((v) => live && setSn(v));
    return () => {
      live = false;
    };
  }, [m?.userId, m?.received, m?.reason]);

  if (!m) return null;
  const name = displayNameOf(users, m.userId);
  const invalid = m.reason === "invalid";

  return (
    <div className="modal-layer" role="alertdialog" aria-modal="true" aria-label="Security key changed">
      <div className="modal" style={{ width: "min(480px, calc(100vw - 32px))" }}>
        <header className="modal-head">
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <WarningIcon size={20} /> {invalid ? "Unsafe connection" : "Security key changed"}
          </h2>
        </header>
        <div style={{ padding: "4px 20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {invalid ? (
            <p style={{ margin: 0 }}>
              {name}'s connection offered an invalid security key ({m.received}). The connection may be intercepted,
              so no audio or video is exchanged with {name}.
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              {name}'s security key changed — the connection may be intercepted. Compare safety numbers.
              {m.wasVerified && <strong> You had verified {name}'s previous key.</strong>} No audio or video is exchanged
              with {name} until you decide.
            </p>
          )}
          {!invalid && (
            <div>
              <div className="settings-hint">New safety number (ask {name} to read theirs to you over another channel):</div>
              <div style={{ fontFamily: "monospace", fontSize: 18, letterSpacing: 1, marginTop: 4 }}>{sn ?? "…"}</div>
              <div className="settings-hint" style={{ marginTop: 6 }}>
                A reinstall, a new device or a cleared app profile also changes the key.
              </div>
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn btn-secondary" onClick={disconnectOnIdentityMismatch}>
            Disconnect
          </button>
          {!invalid && (
            <button className="btn btn-danger" onClick={() => trustNewIdentity(m.userId, m.received)}>
              Trust new key
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
