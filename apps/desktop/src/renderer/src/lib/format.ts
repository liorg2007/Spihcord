import type { PeerInfo } from "@shpihcord/call-engine";

const AVATAR_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#1abc9c", "#9b59b6", "#e67e22", "#3498db", "#747f8d"];

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initialOf(name: string): string {
  const ch = [...name.trim()][0];
  return ch ? ch.toUpperCase() : "?";
}

export type BadgeTone = "good" | "warn" | "bad";

export interface PeerBadge {
  tone: BadgeTone;
  label: string;
  detail: string;
}

export function peerBadge(info: PeerInfo | undefined): PeerBadge {
  if (!info) return { tone: "bad", label: "Connecting", detail: "Waiting for connection" };
  const rtt = info.rttMs !== undefined ? `${Math.round(info.rttMs)} ms` : "";
  const loss = info.lossPct !== undefined && info.lossPct >= 0.5 ? ` · ${info.lossPct.toFixed(1)}% loss` : "";
  switch (info.connectionState) {
    case "connected": {
      const relay = info.route === "relay";
      return {
        tone: relay ? "warn" : "good",
        label: [relay ? "Relay" : info.route === "direct" ? "Direct" : "Connected", rtt].filter(Boolean).join(" · "),
        detail: `${relay ? "Relayed via TURN" : info.route === "direct" ? "Direct peer-to-peer" : "Connected"}${rtt ? `, ${rtt} round trip` : ""}${loss}`,
      };
    }
    case "failed":
      return { tone: "bad", label: "Failed", detail: "Connection failed, retrying" };
    case "disconnected":
      return { tone: "bad", label: "Reconnecting", detail: "Connection interrupted" };
    case "closed":
      return { tone: "bad", label: "Closed", detail: "Connection closed" };
    default:
      return { tone: "bad", label: "Connecting", detail: "Establishing connection" };
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
