import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { peerBadge } from "../lib/format";
import { setPeerMuted, setPeerVolume, setVideoHidden } from "../lib/voice";
import { displayNameOf, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { Avatar } from "./Avatar";
import { SpeakerIcon } from "./Icons";

interface PopoverState {
  userId: string | null;
  x: number;
  y: number;
}

const usePopover = create<PopoverState>()(() => ({ userId: null, x: 0, y: 0 }));

export function openUserPopover(userId: string, x: number, y: number): void {
  usePopover.setState({ userId, x, y });
}
export function closeUserPopover(): void {
  usePopover.setState({ userId: null });
}

/** Props for any element that should open the per-user popover on click / right-click. */
export function popoverTriggerProps(userId: string, enabled: boolean) {
  if (!enabled) return {};
  const open = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openUserPopover(userId, e.clientX, e.clientY);
  };
  return { onClick: open, onContextMenu: open, role: "button" as const, tabIndex: 0 };
}

export function UserPopover() {
  const { userId, x, y } = usePopover();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const users = useApp((s) => s.users);
  const selfId = useApp((s) => s.self?.id);
  const peer = useApp((s) => (userId ? s.peers[userId] : undefined));
  const inMyCall = useApp((s) => !!userId && !!s.voiceChannelId && s.voiceStates[userId]?.channelId === s.voiceChannelId);
  const volume = useSettings((s) => (userId ? (s.userVolumes[userId] ?? 1) : 1));
  const muted = useSettings((s) => (userId ? (s.userMuted[userId] ?? false) : false));
  const videoHidden = useSettings((s) => (userId ? !!s.hiddenVideos[userId] : false));
  const allVideoOff = useSettings((s) => s.disableIncomingVideo);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.min(Math.max(pad, x), window.innerWidth - r.width - pad),
      top: Math.min(Math.max(pad, y), window.innerHeight - r.height - pad),
    });
  }, [x, y, userId]);

  useEffect(() => {
    if (!userId) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeUserPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeUserPopover();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeUserPopover);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeUserPopover);
    };
  }, [userId]);

  if (!userId || userId === selfId) return null;
  const name = displayNameOf(users, userId);
  const badge = inMyCall ? peerBadge(peer) : null;
  const pct = Math.round(volume * 100);

  return (
    <div className="popover" ref={ref} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={`${name} options`}>
      <div className="popover-head">
        <Avatar userId={userId} name={name} size={40} />
        <div className="popover-names">
          <div className="popover-name">{name}</div>
          <div className="popover-username">@{users[userId]?.username ?? "unknown"}</div>
        </div>
      </div>
      {badge && (
        <div className={`conn-line tone-${badge.tone}`} title={badge.detail}>
          <span className="dot" /> {badge.detail}
        </div>
      )}
      <div className="popover-section">
        <div className="popover-label">
          <SpeakerIcon size={14} /> User Volume <span className="popover-value">{pct}%</span>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={200}
          step={1}
          value={pct}
          style={{ ["--fill" as string]: `${pct / 2}%` }}
          onChange={(e) => setPeerVolume(userId, Number(e.target.value) / 100)}
          onDoubleClick={() => setPeerVolume(userId, 1)}
          aria-label="User volume"
        />
        <div className="slider-scale">
          <span>0%</span>
          <span>100%</span>
          <span>200%</span>
        </div>
      </div>
      <label className="menu-check">
        <span>Mute</span>
        <input type="checkbox" checked={muted} onChange={(e) => setPeerMuted(userId, e.target.checked)} />
        <span className="checkbox" aria-hidden="true" />
      </label>
      <label className="menu-check menu-check-tight" title={allVideoOff ? "All incoming video is off in Settings" : undefined}>
        <span>Hide Video</span>
        <input type="checkbox" checked={videoHidden || allVideoOff} disabled={allVideoOff} onChange={(e) => setVideoHidden(userId, e.target.checked)} />
        <span className="checkbox" aria-hidden="true" />
      </label>
    </div>
  );
}
