import { useMemo } from "react";
import type { Channel, VoiceState } from "@shpihcord/protocol";
import { hostOf } from "../lib/format";
import { joinVoice } from "../lib/voice";
import { displayNameOf, setApp, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { Avatar } from "./Avatar";
import { HashIcon, HeadphonesOffIcon, MicOffIcon, SpeakerIcon } from "./Icons";
import { popoverTriggerProps } from "./UserPopover";
import { LiveBadge } from "./Stream";
import { UserPanel } from "./UserPanel";
import { VoiceBar } from "./VoiceBar";

export function ChannelSidebar() {
  const channels = useApp((s) => s.channels);
  const voiceStates = useApp((s) => s.voiceStates);
  const serverUrl = useApp((s) => s.session?.serverUrl ?? "");

  const text = channels.filter((c) => c.type === "text");
  const voice = channels.filter((c) => c.type === "voice");
  const byChannel = useMemo(() => {
    const map: Record<string, VoiceState[]> = {};
    for (const vs of Object.values(voiceStates)) (map[vs.channelId] ??= []).push(vs);
    for (const list of Object.values(map)) list.sort((a, b) => a.userId.localeCompare(b.userId));
    return map;
  }, [voiceStates]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header" title={serverUrl}>
        <div className="sidebar-title">Shpihcord</div>
        <div className="sidebar-subtitle">{hostOf(serverUrl)}</div>
      </header>
      <nav className="channel-list">
        {text.length > 0 && <div className="category">Text Channels</div>}
        {text.map((c) => (
          <TextChannelRow key={c.id} channel={c} />
        ))}
        {voice.length > 0 && <div className="category">Voice Channels</div>}
        {voice.map((c) => (
          <VoiceChannelRow key={c.id} channel={c} participants={byChannel[c.id] ?? []} />
        ))}
        {channels.length === 0 && <div className="sidebar-empty">No channels yet.</div>}
      </nav>
      <VoiceBar />
      <UserPanel />
    </aside>
  );
}

function TextChannelRow({ channel }: { channel: Channel }) {
  const selected = useApp((s) => s.selectedChannelId === channel.id);
  return (
    <button className={`channel${selected ? " selected" : ""}`} onClick={() => setApp({ selectedChannelId: channel.id })}>
      <HashIcon size={18} className="channel-icon" />
      <span className="channel-name">{channel.name}</span>
    </button>
  );
}

function VoiceChannelRow({ channel, participants }: { channel: Channel; participants: VoiceState[] }) {
  const selected = useApp((s) => s.selectedChannelId === channel.id);
  const connected = useApp((s) => s.voiceChannelId === channel.id);
  return (
    <div className="voice-channel">
      <button
        className={`channel${selected ? " selected" : ""}${connected ? " connected" : ""}`}
        onClick={() => {
          setApp({ selectedChannelId: channel.id });
          if (!connected) void joinVoice(channel.id);
        }}
        title={connected ? channel.name : `Join ${channel.name}`}
      >
        <SpeakerIcon size={18} className="channel-icon" />
        <span className="channel-name">{channel.name}</span>
        {participants.length > 0 && <span className="channel-count">{participants.length}</span>}
      </button>
      {participants.length > 0 && (
        <ul className="voice-participants">
          {participants.map((vs) => (
            <VoiceParticipantRow key={vs.userId} vs={vs} inMyCall={connected} />
          ))}
        </ul>
      )}
    </div>
  );
}

function VoiceParticipantRow({ vs, inMyCall }: { vs: VoiceState; inMyCall: boolean }) {
  const users = useApp((s) => s.users);
  const selfId = useApp((s) => s.self?.id);
  const speaking = useApp((s) => inMyCall && !!s.speaking[vs.userId]);
  const selfMuted = useSettings((s) => s.selfMuted);
  const selfDeaf = useSettings((s) => s.selfDeafened);
  const locallyMuted = useSettings((s) => !!s.userMuted[vs.userId]);
  const isSelf = vs.userId === selfId;
  const selfLive = useApp((s) => s.localShare?.status === "live");
  const live = isSelf ? selfLive : vs.streaming;
  // Our own icons follow local state immediately; others come from the hub.
  const muted = isSelf ? selfMuted : vs.muted;
  const deafened = isSelf ? selfDeaf : vs.deafened;
  const name = displayNameOf(users, vs.userId);
  return (
    <li className="voice-participant" {...popoverTriggerProps(vs.userId, !isSelf)}>
      <Avatar userId={vs.userId} name={name} size={24} speaking={speaking} />
      <span className={`vp-name${speaking ? " speaking" : ""}`}>{name}</span>
      <span className="vp-icons">
        {live && <LiveBadge small />}
        {locallyMuted && !isSelf && (
          <span title="Muted by you" className="vp-local-mute">
            <SpeakerIcon size={14} />
          </span>
        )}
        {deafened ? (
          <HeadphonesOffIcon size={14} aria-label="Deafened" />
        ) : muted ? (
          <MicOffIcon size={14} aria-label="Muted" />
        ) : null}
      </span>
    </li>
  );
}
