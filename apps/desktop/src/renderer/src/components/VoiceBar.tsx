import { useMemo } from "react";
import { leaveVoice, openGoLive, stopScreenShare, toggleCamera } from "../lib/voice";
import { useApp } from "../store/app";
import { HangupIcon, ScreenShareIcon, ScreenShareOffIcon, SignalIcon, VideoIcon, VideoOffIcon } from "./Icons";
import { LiveBadge } from "./Stream";

/** The "Voice Connected" panel above the user panel. */
export function VoiceBar() {
  const channelId = useApp((s) => s.voiceChannelId);
  const status = useApp((s) => s.voiceStatus);
  const channel = useApp((s) => s.channels.find((c) => c.id === s.voiceChannelId));
  const peers = useApp((s) => s.peers);
  const hub = useApp((s) => s.connection);
  const share = useApp((s) => s.localShare);
  const camera = useApp((s) => s.cameraStatus);

  const { ping, tone } = useMemo(() => {
    const list = Object.values(peers);
    const rtts = list.map((p) => p.rttMs).filter((v): v is number => typeof v === "number");
    const avg = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : undefined;
    const anyBad = list.some((p) => p.connectionState !== "connected");
    const t = anyBad ? "warn" : avg === undefined || avg < 150 ? "good" : avg < 300 ? "warn" : "bad";
    return { ping: avg, tone: t };
  }, [peers]);

  if (!channelId) return null;
  const connecting = status !== "connected" || hub !== "connected";
  const label = hub !== "connected" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Voice Connected";
  const peerCount = Object.keys(peers).length;

  return (
    <div className="voice-bar-wrap">
      <div className="voice-bar">
        <div className="voice-bar-info">
          <div className={`voice-bar-status ${connecting ? "tone-warn" : `tone-${tone}`}`}>
            <SignalIcon size={16} />
            <span>{label}</span>
          </div>
          <div className="voice-bar-sub">
            <span className="voice-bar-channel">{channel?.name ?? "Voice"}</span>
            {!connecting && (
              <span className="voice-bar-ping" title="Average round-trip time to peers">
                {" · "}
                {peerCount === 0 ? "alone" : ping !== undefined ? `${ping} ms` : "measuring…"}
              </span>
            )}
          </div>
        </div>
        <button className="icon-btn danger" onClick={() => leaveVoice()} title="Disconnect" aria-label="Disconnect">
          <HangupIcon size={20} />
        </button>
      </div>
      {share?.status === "live" && (
        <div className="voice-bar-live">
          <LiveBadge small />
          <span>
            {share.viewers.length} {share.viewers.length === 1 ? "viewer" : "viewers"}
          </span>
        </div>
      )}
      <div className="voice-bar-actions">
        <button
          className={`voice-bar-btn${camera !== "off" ? " cam-on" : ""}`}
          onClick={toggleCamera}
          disabled={connecting && camera === "off"}
          title={camera === "off" ? "Turn On Camera" : "Turn Off Camera"}
          aria-pressed={camera !== "off"}
        >
          {camera === "off" ? <VideoOffIcon size={18} /> : <VideoIcon size={18} />}
          <span>{camera === "starting" ? "Starting…" : "Video"}</span>
        </button>
        <button
          className={`voice-bar-btn${share ? " live" : ""}`}
          onClick={() => (share ? stopScreenShare() : openGoLive())}
          disabled={connecting && !share}
          title={share ? "Stop Streaming" : "Share Your Screen"}
        >
          {share ? <ScreenShareOffIcon size={18} /> : <ScreenShareIcon size={18} />}
          <span>{share ? "Stop Stream" : "Screen"}</span>
        </button>
      </div>
    </div>
  );
}
