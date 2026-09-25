import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Channel, VoiceState } from "@shpihcord/protocol";
import { peerBadge } from "../lib/format";
import { useCameraPrefTile } from "../lib/cameraPrefs";
import {
  joinVoice,
  leaveVoice,
  openGoLive,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  watchStream,
} from "../lib/voice";
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
  ShieldIcon,
  SpeakerIcon,
  StatsIcon,
  VideoIcon,
  VideoOffIcon,
} from "./Icons";
import { LiveBadge, LiveBar, StreamStage, StreamVideo, statLine } from "./Stream";
import { popoverTriggerProps } from "./UserPopover";
import { useVerified } from "../lib/identity";

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
        <TileGrid count={count}>
          {participants.map((vs) => (
            <ParticipantTile key={vs.userId} vs={vs} />
          ))}
          {count === 0 && <div className="muted">{status === "connecting" ? "Connecting…" : "Joining…"}</div>}
        </TileGrid>
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

const GRID_GAP = 12;
const GRID_PAD = 20;
const MIN_TILE_W = 200;
const MAX_TILE_W = 1600;

/**
 * Pick the column count that makes 16:9 tiles as large as possible inside the
 * container (1 → one big tile, 2 → side by side, 3–4 → 2×2, …). Below
 * MIN_TILE_W the grid scrolls instead of shrinking further.
 */
export function gridLayout(count: number, width: number, height: number): { cols: number; tileW: number } {
  const n = Math.max(1, count);
  const W = Math.max(0, width - GRID_PAD * 2);
  const H = Math.max(0, height - GRID_PAD * 2);
  let best = { cols: 1, tileW: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byW = (W - GRID_GAP * (cols - 1)) / cols;
    const byH = ((H - GRID_GAP * (rows - 1)) / rows) * (16 / 9);
    const w = Math.min(byW, byH, MAX_TILE_W);
    if (w > best.tileW + 0.5) best = { cols, tileW: w };
  }
  if (best.tileW < MIN_TILE_W) {
    const cols = Math.max(1, Math.min(n, Math.floor((W + GRID_GAP) / (MIN_TILE_W + GRID_GAP))));
    best = { cols, tileW: Math.max(0, Math.min(MIN_TILE_W, (W - GRID_GAP * (cols - 1)) / cols)) };
  }
  return { cols: best.cols, tileW: Math.floor(best.tileW) };
}

function useElementSize(ref: RefObject<HTMLElement>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((prev) => (prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1 ? prev : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function TileGrid({ count, children }: { count: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const layout = size ? gridLayout(count, size.width, size.height) : null;
  const style = layout
    ? { ["--cols" as string]: layout.cols, ["--tile-w" as string]: `${layout.tileW}px` }
    : { ["--cols" as string]: count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4 };
  return (
    <div className="tile-grid-wrap" ref={ref}>
      <div className={`tile-grid${layout ? " sized" : ""}`} style={style}>
        {children}
      </div>
    </div>
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
  const videoHidden = useSettings((s) => s.disableIncomingVideo || !!s.hiddenVideos[vs.userId]);
  const showStats = useSettings((s) => s.streamStatsOverlay);
  const isSelf = vs.userId === selfId;
  const name = displayNameOf(users, vs.userId);
  const serverUrl = useApp((st) => st.session?.serverUrl);
  const verified = useVerified(serverUrl, isSelf ? null : vs.userId);
  const muted = isSelf ? selfMuted : vs.muted;
  const deafened = isSelf ? selfDeaf : vs.deafened;
  const badge = isSelf ? null : peerBadge(peer);
  const localStream = useApp((s) => (isSelf && s.localShare?.status === "live" ? s.localShare.stream : null));
  // Camera: ours from the localCamera event (instant); others' when the hub says video is on.
  const camStream = useApp((s) =>
    isSelf ? (s.cameraStatus === "on" ? s.localCamera : null) : vs.video && !videoHidden ? (s.remoteCameras[vs.userId] ?? null) : null,
  );
  const focused = useApp((s) => s.focusedStream === vs.userId);
  const connected = useApp((s) => s.voiceStatus === "connected");
  const tileRef = useCameraPrefTile(vs.userId, !!compact, !isSelf);
  // Our own LIVE state is local (instant); others' comes from the hub.
  const live = isSelf ? !!localStream : vs.streaming;
  const hasVideo = !!camStream;
  const pausedByMe = !isSelf && vs.video && videoHidden;

  return (
    <div
      ref={tileRef}
      className={`tile${speaking ? " speaking" : ""}${compact ? " compact" : ""}${focused ? " focused" : ""}${live ? " live" : ""}${hasVideo ? " has-video" : ""}`}
      {...popoverTriggerProps(vs.userId, !isSelf)}
      title={isSelf ? undefined : "Click for volume, mute and video"}
    >
      {camStream ? (
        <StreamVideo stream={camStream} className={`tile-video camera${isSelf ? " mirrored" : ""}`} />
      ) : localStream && !focused ? (
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
      {hasVideo && showStats && !compact && <CameraStats userId={vs.userId} isSelf={isSelf} belowLive={live} />}
      <div className="tile-footer">
        <span className="tile-name">
          {name}
          {isSelf && <span className="tile-you">you</span>}
        </span>
        <span className="tile-icons">
          {verified && !peer?.identityBlocked && (
            <span className="tile-chip" title="Security key verified" style={{ color: "var(--green)" }}>
              <ShieldIcon size={14} />
            </span>
          )}
          {!isSelf && Math.abs(volume - 1) > 0.005 && !locallyMuted && <span className="tile-vol">{Math.round(volume * 100)}%</span>}
          {pausedByMe && (
            <span className="tile-chip video-paused" title="You aren't receiving this camera">
              <VideoOffIcon size={14} /> {compact ? "" : "video hidden"}
            </span>
          )}
          {locallyMuted && !isSelf && (
            <span className="tile-chip" title="Muted by you">
              <SpeakerIcon size={14} /> muted
            </span>
          )}
          {deafened ? <HeadphonesOffIcon size={16} /> : muted ? <MicOffIcon size={16} /> : null}
        </span>
      </div>
      {!compact && (badge || hasVideo) && (
        <div className="tile-top-right">
          {hasVideo && (
            <button
              className={`tile-stats-btn${showStats ? " toggled" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                useSettings.getState().update({ streamStatsOverlay: !showStats });
              }}
              onContextMenu={(e) => e.stopPropagation()}
              title={showStats ? "Hide video stats" : "Show video stats"}
              aria-label={showStats ? "Hide video stats" : "Show video stats"}
            >
              <StatsIcon size={14} />
            </button>
          )}
          {badge && (
            <div className={`conn-badge tone-${badge.tone}`} title={badge.detail}>
              <span className="dot" />
              {badge.label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Camera stats for a tile: what we receive, or what we send to each viewer. */
function CameraStats({ userId, isSelf, belowLive }: { userId: string; isSelf: boolean; belowLive: boolean }) {
  const users = useApp((s) => s.users);
  const recv = useApp((s) => (isSelf ? undefined : s.streamStats[`cam:recv:${userId}`]));
  const allStats = useApp((s) => (isSelf ? s.streamStats : null));
  const send = useMemo(
    () =>
      allStats
        ? Object.entries(allStats)
            .filter(([k]) => k.startsWith("cam:send:"))
            .map(([k, st]) => ({ viewer: k.slice(9), stats: st }))
        : [],
    [allStats],
  );
  return (
    <div className={`tile-stats${belowLive ? " below-live" : ""}`}>
      {isSelf ? (
        send.length === 0 ? (
          <div>Camera · no one receiving</div>
        ) : (
          send.map(({ viewer, stats }) => (
            <div key={viewer}>
              <strong>{displayNameOf(users, viewer)}:</strong> {statLine(stats)}
              {stats.qualityLimitation && stats.qualityLimitation !== "none" && (
                <span className="stat-limit"> · {stats.qualityLimitation}</span>
              )}
            </div>
          ))
        )
      ) : (
        <div>{statLine(recv)}</div>
      )}
    </div>
  );
}

function CallControls() {
  const muted = useSettings((s) => s.selfMuted);
  const deafened = useSettings((s) => s.selfDeafened);
  const connected = useApp((s) => s.voiceStatus === "connected");
  const sharing = useApp((s) => !!s.localShare);
  const camera = useApp((s) => s.cameraStatus);
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
        className={`round-btn${camera !== "off" ? " cam-on" : ""}${camera === "starting" ? " pending" : ""}`}
        onClick={toggleCamera}
        disabled={!connected && camera === "off"}
        title={camera === "off" ? "Turn On Camera" : "Turn Off Camera"}
        aria-pressed={camera !== "off"}
      >
        {camera === "off" ? <VideoOffIcon size={22} /> : <VideoIcon size={22} />}
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
