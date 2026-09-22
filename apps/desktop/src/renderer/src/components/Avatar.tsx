import { avatarColor, initialOf } from "../lib/format";

interface AvatarProps {
  userId: string;
  name: string;
  size?: number;
  speaking?: boolean;
  /** Presence dot. */
  status?: "online" | "offline" | "idle" | null;
  dim?: boolean;
}

export function Avatar({ userId, name, size = 32, speaking = false, status = null, dim = false }: AvatarProps) {
  return (
    <span
      className={`avatar${speaking ? " speaking" : ""}${dim ? " dim" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: avatarColor(userId) }}
      aria-label={name}
    >
      {initialOf(name)}
      {status && <span className={`status-dot ${status}`} style={{ width: Math.max(10, size * 0.32), height: Math.max(10, size * 0.32) }} />}
    </span>
  );
}
