import type { ReactNode } from "react";
import { reconnectNow } from "../lib/session";
import { useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { ChatIcon, HashIcon, SpeakerIcon, UsersIcon } from "./Icons";
import { VoiceView } from "./VoiceView";

export function MainArea() {
  const channel = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId));
  const showMembers = useSettings((s) => s.showMemberList);

  return (
    <main className="main">
      <header className="main-header">
        {channel ? (
          <>
            {channel.type === "voice" ? <SpeakerIcon size={22} className="header-icon" /> : <HashIcon size={22} className="header-icon" />}
            <h2 className="main-title">{channel.name}</h2>
          </>
        ) : (
          <h2 className="main-title">Shpihcord</h2>
        )}
        <div className="header-spacer" />
        <button
          className={`icon-btn${showMembers ? " toggled" : ""}`}
          onClick={() => useSettings.getState().update({ showMemberList: !showMembers })}
          title={showMembers ? "Hide Member List" : "Show Member List"}
        >
          <UsersIcon size={20} />
        </button>
      </header>
      <ConnectionBanner />
      <div className="main-body">
        {!channel ? (
          <EmptyState title="Nothing selected" text="Pick a channel on the left." />
        ) : channel.type === "voice" ? (
          <VoiceView channel={channel} />
        ) : (
          <EmptyState
            icon={<ChatIcon size={40} />}
            title={`Welcome to #${channel.name}!`}
            text="Text chat is coming soon. For now, hop into a voice channel."
          />
        )}
      </div>
    </main>
  );
}

function EmptyState({ icon, title, text }: { icon?: ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      <p className="muted">{text}</p>
    </div>
  );
}

function ConnectionBanner() {
  const connection = useApp((s) => s.connection);
  const retryInMs = useApp((s) => s.retryInMs);
  if (connection === "connected" || connection === "stopped") return null;
  const text =
    connection === "connecting"
      ? "Connecting to server…"
      : retryInMs
        ? `Connection lost. Retrying in ${Math.max(1, Math.round(retryInMs / 1000))}s…`
        : "Connection lost. Reconnecting…";
  return (
    <div className="conn-banner">
      <span className="spinner small" />
      {text}
      {connection === "reconnecting" && (
        <button className="link" onClick={reconnectNow}>
          Retry now
        </button>
      )}
    </div>
  );
}
