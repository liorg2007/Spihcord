import { toggleDeafen, toggleMute } from "../lib/voice";
import { setApp, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { Avatar } from "./Avatar";
import { GearIcon, HeadphonesIcon, HeadphonesOffIcon, MicIcon, MicOffIcon } from "./Icons";

export function UserPanel() {
  const self = useApp((s) => s.self ?? s.session?.user ?? null);
  const connection = useApp((s) => s.connection);
  const speaking = useApp((s) => !!self && !!s.speaking[self.id]);
  const inVoice = useApp((s) => !!s.voiceChannelId);
  const pttActive = useApp((s) => s.pttActive);
  const muted = useSettings((s) => s.selfMuted);
  const deafened = useSettings((s) => s.selfDeafened);
  const inputMode = useSettings((s) => s.inputMode);
  const binding = useSettings((s) => s.pttBinding);
  if (!self) return null;

  const status =
    connection === "connected"
      ? inputMode === "push-to-talk" && inVoice
        ? pttActive
          ? "Transmitting"
          : `Push to talk · ${binding?.label ?? "unbound"}`
        : "Online"
      : connection === "stopped"
        ? "Offline"
        : "Connecting…";

  return (
    <section className="user-panel">
      <div className="user-panel-id">
        <Avatar
          userId={self.id}
          name={self.displayName || self.username}
          size={32}
          speaking={speaking}
          status={connection === "connected" ? "online" : connection === "stopped" ? "offline" : "idle"}
        />
        <div className="user-panel-names">
          <div className="user-panel-name">{self.displayName || self.username}</div>
          <div className="user-panel-status">{status}</div>
        </div>
      </div>
      <div className="user-panel-actions">
        <button
          className={`icon-btn${muted || deafened ? " active-off" : ""}`}
          onClick={toggleMute}
          title={muted || deafened ? "Unmute" : "Mute"}
          aria-pressed={muted || deafened}
        >
          {muted || deafened ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
        </button>
        <button
          className={`icon-btn${deafened ? " active-off" : ""}`}
          onClick={toggleDeafen}
          title={deafened ? "Undeafen" : "Deafen"}
          aria-pressed={deafened}
        >
          {deafened ? <HeadphonesOffIcon size={20} /> : <HeadphonesIcon size={20} />}
        </button>
        <button className="icon-btn" onClick={() => setApp({ settingsOpen: true })} title="User Settings">
          <GearIcon size={20} />
        </button>
      </div>
    </section>
  );
}
