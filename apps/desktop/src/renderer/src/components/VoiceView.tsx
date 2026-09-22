import { useMemo } from "react";
import type { Channel, VoiceState } from "@shpihcord/protocol";
import { peerBadge } from "../lib/format";
import { joinVoice, leaveVoice, openGoLive, stopScreenShare, toggleDeafen, toggleMute, watchStream } from "../lib/voice";
import { displayNameOf, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { Avatar } from "./Avatar";
import {
  EyeIcon,
  HangupIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
  SpeakerIcon,
} from "./Icons";
import { LiveBadge, LiveBar, StreamStage, StreamVideo } from "./Stream";
import { popoverTriggerProps } from "./UserPopover";

export function VoiceView({ channel }: { channel: Channel }) {
  const voiceStates = useApp((s) => s.voiceStates);
  const myChannel = useApp((s) => s.voiceChannelId);
  const status = useApp((s) => s.voiceStatus);
  const connection = useApp((s) => s.connection);
  const focused = useApp((s) => s.focusedStream);
  const participants = useMemo(
    () => Object.values(voiceStates).filter((v) => v.channelId === channel.id).sort((a, b) => a.userId.localeCompare(b.userId)),
    [voiceStates, channel.id],
  );
  const joined = myChannel === channel.id;

  if (!joined) {
    return (
      <div className="voice-view preview">
        <div className="voice-preview">
          <div className="voice-preview-icon">
            <SpeakerIcon size={36} />
          </div>
          <h2>{channel.name}</h2>
          <p className="muted">
            {participants.length === 0
              ? "No one is here yet. Jump in and friends can join you."
              : `${participants.length} ${participants.length === 1 ? "person is" : "people are"} talking.`}
          </p>
          {participants.length > 0 && (
            <div className="avatar-stack">
              {participants.slice(0, 8).map((vs) => (
                <PreviewAvatar key={vs.userId} vs={vs} />
              ))}
            </div>
          )}
          <button className="btn btn-green" disabled={connection !== "connected"} onClick={() => void joinVoice(channel.id)}>
            Join Voice
          </button>
        </div>
      </div>
    );
  }

  const count = participants.length;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  const stageUser = focused && participants.some((p) => p.userId === focused) ? focused : null;
  return (
    <div className="voice-view">
      <LiveBar />
      {stageUser ? (
        <div className="stage-layout">
          <StreamStage userId={stageUser} />
          <div className="tile-strip">
            {participants.map((vs) => (
              <ParticipantTile key={vs.userId} vs={vs} compact />
            ))}
          </div>
        </div>
      ) : (
        <div className="tile-grid" style={{ ["--cols" as string]: cols }}>
          {participants.map((vs) => (
            <ParticipantTile key={vs.userId} vs={vs} />
          ))}
          {count === 0 && <div className="muted">{status === "connecting" ? "Connecting…" : "Joining…"}</div>}
        </div>
      )}
      <CallControls />
    </div>
  );
}

function PreviewAvatar({ vs }: { vs: VoiceState }) {
  const users = useApp((s) => s.users);
  const name = displayNameOf(users, vs.userId);
  return (
    <span title={name}>
      <Avatar userId={vs.userId} name={name} size={40} />
    </span>
  );
}

function ParticipantTile({ vs, compact }: { vs: VoiceState; compact?: boolean }) {
  const users = useApp((s) => s.users);
  const selfId = useApp((s) => s.self?.id);
  const speaking = useApp((s) => !!s.speaking[vs.userId]);
  const peer = useApp((s) => s.peers[vs.userId]);
  const selfMuted = useSettings((s) => s.selfMuted);
  const selfDeaf = useSettings((s) => s.selfDeafened);
  const volume = useSettings((s) => s.userVolumes[vs.userId] ?? 1);
  const locallyMuted = useSettings((s) => !!s.userMuted[vs.userId]);
  const isSelf = vs.userId === selfId;
  const name = displayNameOf(users, vs.userId);
  const muted = isSelf ? selfMuted : vs.muted;
  const deafened = isSelf ? selfDeaf : vs.deafened;
  const badge = isSelf ? null : peerBadge(peer);
  const localStream = useApp((s) => (isSelf && s.localShare?.status === "live" ? s.localShare.stream : null));
  const focused = useApp((s) => s.focusedStream === vs.userId);
  const connected = useApp((s) => s.voiceStatus === "connected");
  // Our own LIVE state is local (instant); others' comes from the hub.
  const live = isSelf ? !!localStream : vs.streaming;

  return (
    <div
      className={`tile${speaking ? " speaking" : ""}${compact ? " compact" : ""}${focused ? " focused" : ""}${live ? " live" : ""}`}
      {...popoverTriggerProps(vs.userId, !isSelf)}
      title={isSelf ? undefined : "Click for volume and mute"}
    >
      {localStream && !focused ? (
        <StreamVideo stream={localStream} className="tile-video" />
      ) : (
        <div className="tile-center">
          <Avatar userId={vs.userId} name={name} size={compact ? 48 : 88} speaking={speaking} dim={locallyMuted} />
        </div>
      )}
      {live && (
        <div className="tile-live">
          <LiveBadge small={compact} />
        </div>
      )}
      {live && !focused && connected && (
        <div className="tile-watch">
          <button
            className="btn btn-small btn-primary"
            onClick={(e) => {
              e.stopPropagation();
              watchStream(vs.userId);
            }}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <EyeIcon size={16} /> {isSelf ? "Preview" : "Watch Stream"}
          </button>
        </div>
      )}
      <div className="tile-footer">
        <span className="tile-name">
          {name}
          {isSelf && <span className="tile-you">you</span>}
        </span>
        <span className="tile-icons">
          {!isSelf && Math.abs(volume - 1) > 0.005 && !locallyMuted && <span className="tile-vol">{Math.round(volume * 100)}%</span>}
          {locallyMuted && !isSelf && (
            <span className="tile-chip" title="Muted by you">
              <SpeakerIcon size={14} /> muted
            </span>
          )}
          {deafened ? <HeadphonesOffIcon size={16} /> : muted ? <MicOffIcon size={16} /> : null}
        </span>
      </div>
      {badge && !compact && (
        <div className={`conn-badge tone-${badge.tone}`} title={badge.detail}>
          <span className="dot" />
          {badge.label}
        </div>
      )}
    </div>
  );
}

function CallControls() {
  const muted = useSettings((s) => s.selfMuted);
  const deafened = useSettings((s) => s.selfDeafened);
  const connected = useApp((s) => s.voiceStatus === "connected");
  const sharing = useApp((s) => !!s.localShare);
  const mutedAny = muted || deafened;
  return (
    <div className="call-controls">
      <button className={`round-btn${mutedAny ? " off" : ""}`} onClick={toggleMute} title={mutedAny ? "Unmute" : "Mute"}>
        {mutedAny ? <MicOffIcon size={22} /> : <MicIcon size={22} />}
      </button>
      <button className={`round-btn${deafened ? " off" : ""}`} onClick={toggleDeafen} title={deafened ? "Undeafen" : "Deafen"}>
        {deafened ? <HeadphonesOffIcon size={22} /> : <HeadphonesIcon size={22} />}
      </button>
      <button
        className={`round-btn${sharing ? " live" : ""}`}
        onClick={() => (sharing ? stopScreenShare() : openGoLive())}
        disabled={!connected && !sharing}
        title={sharing ? "Stop Streaming" : "Share Your Screen"}
      >
        {sharing ? <ScreenShareOffIcon size={22} /> : <ScreenShareIcon size={22} />}
      </button>
      <button className="round-btn hangup" onClick={() => leaveVoice()} title="Disconnect">
        <HangupIcon size={26} />
      </button>
    </div>
  );
}
