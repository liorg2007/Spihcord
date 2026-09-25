/** Screen share UI pieces: the stage (focused stream), the sharer's live bar, LIVE badge. */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SCREEN_SHARE_PRESETS, type ScreenSharePresetId, type StreamStats } from "@shpihcord/call-engine";
import { formatMbps } from "../lib/format";
import { setScreenSharePreset, setStreamVolume, stopScreenShare, stopWatching, watchStream } from "../lib/voice";
import { displayNameOf, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { Avatar } from "./Avatar";
import { ExitFullscreenIcon, EyeIcon, FullscreenIcon, StatsIcon, VolumeIcon, VolumeOffIcon, WarningIcon } from "./Icons";
import { PRESET_ORDER } from "./GoLiveModal";

const NO_VIEWERS: string[] = [];

export function LiveBadge({ small }: { small?: boolean }) {
  return <span className={`live-badge${small ? " small" : ""}`}>LIVE</span>;
}

/** A muted <video> bound to a MediaStream (stream audio is played by the engine, never here). */
export function StreamVideo({ stream, className, onDoubleClick }: { stream: MediaStream; className?: string; onDoubleClick?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted onDoubleClick={onDoubleClick} />;
}

function useFullscreen(ref: RefObject<HTMLElement>) {
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFs(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void ref.current?.requestFullscreen().catch(() => {});
  };
  return { isFs, toggle };
}

export function statLine(s: StreamStats | undefined): string {
  if (!s) return "Waiting for stats…";
  const parts: string[] = [];
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.fps !== undefined) parts.push(`${Math.round(s.fps)} fps`);
  if (s.codec) parts.push(s.codec);
  if (s.bitrateKbps !== undefined) parts.push(s.bitrateKbps >= 1000 ? `${(s.bitrateKbps / 1000).toFixed(1)} Mbps` : `${Math.round(s.bitrateKbps)} kbps`);
  return parts.join(" · ") || "Waiting for stats…";
}

/** The large focused stream ("stage"), for a remote sharer or our own preview. */
export function StreamStage({ userId }: { userId: string }) {
  const selfId = useApp((s) => s.self?.id);
  const isSelf = userId === selfId;
  const users = useApp((s) => s.users);
  const stream = useApp((s) => (isSelf ? s.localShare?.stream ?? null : s.remoteStreams[userId] ?? null));
  const recvStats = useApp((s) => s.streamStats[`recv:${userId}`]);
  const allStats = useApp((s) => s.streamStats);
  const viewers = useApp((s) => s.localShare?.viewers ?? NO_VIEWERS);
  const volume = useSettings((s) => s.streamVolumes[userId] ?? 1);
  const showStats = useSettings((s) => s.streamStatsOverlay);
  const ref = useRef<HTMLDivElement>(null);
  const { isFs, toggle } = useFullscreen(ref);
  const name = displayNameOf(users, userId);
  const lastVolume = useRef(1);

  const sendStats = useMemo(
    () => (isSelf ? viewers.map((v) => ({ viewer: v, stats: allStats[`send:${v}`] })) : []),
    [isSelf, viewers, allStats],
  );

  return (
    <div className={`stage${isFs ? " fullscreen" : ""}`} ref={ref}>
      {stream ? (
        <StreamVideo stream={stream} className="stage-video" onDoubleClick={toggle} />
      ) : (
        <div className="stage-wait">
          <span className="spinner" />
          <span>Joining {name}'s stream…</span>
        </div>
      )}
      <div className="stage-top">
        <LiveBadge />
        <span className="stage-name">{isSelf ? "Your stream (preview)" : name}</span>
      </div>
      {showStats && (
        <div className="stage-stats">
          {isSelf ? (
            sendStats.length === 0 ? (
              <div>No viewers yet</div>
            ) : (
              sendStats.map(({ viewer, stats }) => (
                <div key={viewer}>
                  <strong>{displayNameOf(users, viewer)}:</strong> {statLine(stats)}
                  {stats?.qualityLimitation && stats.qualityLimitation !== "none" && (
                    <span className="stat-limit"> · limited by {stats.qualityLimitation}</span>
                  )}
                </div>
              ))
            )
          ) : (
            <div>{statLine(recvStats)}</div>
          )}
        </div>
      )}
      <div className="stage-controls">
        {!isSelf && (
          <div className="stage-volume" title={`Stream volume ${Math.round(volume * 100)}%`}>
            <button
              className="icon-btn"
              onClick={() => {
                if (volume > 0) {
                  lastVolume.current = volume;
                  setStreamVolume(userId, 0);
                } else setStreamVolume(userId, lastVolume.current || 1);
              }}
              aria-label={volume > 0 ? "Mute stream" : "Unmute stream"}
            >
              {volume > 0 ? <VolumeIcon size={20} /> : <VolumeOffIcon size={20} />}
            </button>
            <input
              type="range"
              className="slider"
              min={0}
              max={200}
              step={1}
              value={Math.round(volume * 100)}
              style={{ ["--fill" as string]: `${(volume / 2) * 100}%` }}
              onChange={(e) => setStreamVolume(userId, Number(e.target.value) / 100)}
              aria-label="Stream volume"
            />
          </div>
        )}
        <div className="header-spacer" />
        <button
          className={`icon-btn${showStats ? " toggled" : ""}`}
          onClick={() => useSettings.getState().update({ streamStatsOverlay: !showStats })}
          title={showStats ? "Hide stream stats" : "Show stream stats"}
        >
          <StatsIcon size={20} />
        </button>
        <button className="icon-btn" onClick={toggle} title={isFs ? "Exit full screen" : "Full screen"}>
          {isFs ? <ExitFullscreenIcon size={20} /> : <FullscreenIcon size={20} />}
        </button>
        <button className="btn btn-small btn-secondary" onClick={() => stopWatching(userId)}>
          {isSelf ? "Close Preview" : "Stop Watching"}
        </button>
      </div>
    </div>
  );
}

/** "You're live" bar for the sharer: viewers, quality switcher, upload hints, stop. */
export function LiveBar() {
  const share = useApp((s) => s.localShare);
  const users = useApp((s) => s.users);
  const selfId = useApp((s) => s.self?.id);
  const focused = useApp((s) => s.focusedStream);
  const stats = useApp((s) => s.streamStats);
  if (!share) return null;

  if (share.status === "starting") {
    return (
      <div className="live-bar">
        <span className="spinner small" />
        <span className="live-title">Starting your stream…</span>
        <div className="header-spacer" />
        <button className="btn btn-small btn-secondary" onClick={() => stopScreenShare()}>
          Cancel
        </button>
      </div>
    );
  }

  const n = share.viewers.length;
  const preset = SCREEN_SHARE_PRESETS[share.preset];
  const bwLimited = share.viewers.filter((v) => stats[`send:${v}`]?.qualityLimitation === "bandwidth");
  const cpuLimited = share.viewers.some((v) => stats[`send:${v}`]?.qualityLimitation === "cpu");
  const need = preset.maxBitrate * Math.max(1, n);

  return (
    <div className="live-bar">
      <LiveBadge />
      <div className="live-info">
        <div className="live-title">
          You're live{share.sourceName ? <span className="muted"> · {share.sourceName}</span> : null}
        </div>
        <div className="live-sub">
          {n === 0 ? (
            "No one is watching yet"
          ) : (
            <span className="live-viewers" title={share.viewers.map((v) => displayNameOf(users, v)).join(", ")}>
              <EyeIcon size={14} /> {n} {n === 1 ? "viewer" : "viewers"}:{" "}
              {share.viewers.map((v) => (
                <span key={v} className="live-viewer">
                  <Avatar userId={v} name={displayNameOf(users, v)} size={16} />
                  {displayNameOf(users, v)}
                </span>
              ))}
            </span>
          )}
          <span className="muted"> · ~{formatMbps(need)} upload{n > 1 ? ` (${formatMbps(preset.maxBitrate)} × ${n})` : ""}</span>
          {share.audio === "none" && <span className="muted"> · no audio</span>}
          {share.audio === "app" && <span className="muted"> · app audio only</span>}
        </div>
        {bwLimited.length > 0 && (
          <div className="live-warn">
            <WarningIcon size={14} /> Your upload can't keep up with {bwLimited.map((v) => displayNameOf(users, v)).join(", ")}. Try a lower
            quality.
          </div>
        )}
        {cpuLimited && (
          <div className="live-warn">
            <WarningIcon size={14} /> Your PC is struggling to encode the stream. Try a lower quality.
          </div>
        )}
        {share.audioWarning && (
          <div className="live-warn">
            <WarningIcon size={14} /> {share.audioWarning}
          </div>
        )}
      </div>
      <div className="select-wrap live-preset">
        <select
          value={share.preset}
          onChange={(e) => void setScreenSharePreset(e.target.value as ScreenSharePresetId)}
          aria-label="Stream quality"
        >
          {PRESET_ORDER.map((id) => (
            <option key={id} value={id}>
              {SCREEN_SHARE_PRESETS[id].label} ({formatMbps(SCREEN_SHARE_PRESETS[id].maxBitrate)}/viewer)
            </option>
          ))}
        </select>
      </div>
      {selfId && focused !== selfId && (
        <button className="btn btn-small btn-secondary" onClick={() => watchStream(selfId)}>
          Preview
        </button>
      )}
      <button className="btn btn-small btn-danger" onClick={() => stopScreenShare()}>
        Stop Streaming
      </button>
    </div>
  );
}
