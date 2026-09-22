import type { HubFatal } from "../lib/hub";
import { logout, reconnectHere } from "../lib/session";
import { WifiOffIcon } from "./Icons";

export function FatalScreen({ fatal }: { fatal: HubFatal }) {
  const outdated = fatal.kind === "outdated";
  return (
    <div className="fatal-overlay">
      <div className="fatal-card">
        <div className="fatal-icon">
          <WifiOffIcon size={34} />
        </div>
        <h2>{outdated ? "Please update Shpihcord" : "You're connected somewhere else"}</h2>
        <p className="muted">
          {outdated
            ? "The server runs a newer version than this app. Download the latest version to keep chatting."
            : "Your account signed in from another window or device, so this one was disconnected."}
        </p>
        {fatal.message && <p className="fatal-detail">{fatal.message}</p>}
        <div className="fatal-actions">
          {!outdated && (
            <button className="btn btn-primary" onClick={reconnectHere}>
              Use Shpihcord here
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
