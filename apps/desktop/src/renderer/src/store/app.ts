/** Runtime app state: session, hub snapshot, voice call state, toasts. */
import { create } from "zustand";
import type { Channel, IceServer, ServerMessage, User, VoiceState } from "@shpihcord/protocol";
import type { PeerInfo, ScreenSharePresetId, StreamStats } from "@shpihcord/call-engine";
import type { ScreenAudioMode, StoredSession } from "../../../shared/ipc";
import type { HubFatal, HubStatus } from "../lib/hub";

export type Screen = "loading" | "login" | "app";
export type VoiceStatus = "idle" | "connecting" | "connected";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

/** Our own camera: "starting" while the engine acquires the device. */
export type CameraStatus = "off" | "starting" | "on";

/** Our own screen share ("Go Live"). */
export interface LocalShare {
  status: "starting" | "live";
  preset: ScreenSharePresetId;
  sourceName: string;
  /** Audio actually being shared. */
  audio: ScreenAudioMode;
  /** Shown while live, e.g. "friends may hear themselves". */
  audioWarning: string | null;
  /** The captured stream (for the local preview). */
  stream: MediaStream | null;
  /** Users currently receiving our stream. */
  viewers: string[];
}

export interface AppState {
  screen: Screen;
  session: StoredSession | null;
  /** Message shown on the login screen (e.g. "session expired"). */
  loginNotice: string | null;

  connection: HubStatus;
  retryInMs: number | undefined;
  /** Non-recoverable hub errors (outdated client / session replaced). */
  fatal: HubFatal | null;
  /** True once the first `ready` arrived (keeps UI visible during reconnects). */
  hasSnapshot: boolean;

  self: User | null;
  users: Record<string, User>;
  online: Record<string, true>;
  channels: Channel[];
  voiceStates: Record<string, VoiceState>;
  iceServers: IceServer[];

  selectedChannelId: string | null;

  voiceChannelId: string | null;
  voiceStatus: VoiceStatus;
  peers: Record<string, PeerInfo>;
  speaking: Record<string, true>;
  pttActive: boolean;
  /** Whether PTT is using the global (system-wide) hook. */
  pttGlobal: boolean;

  /** Go Live picker open. */
  goLiveOpen: boolean;
  localShare: LocalShare | null;
  /** The stream shown in the stage (a sharer's userId, or our own id for the local preview). */
  focusedStream: string | null;
  /** Remote screen streams we are receiving, by sharer. */
  remoteStreams: Record<string, MediaStream>;
  /**
   * Latest stats per stream: screen `send:<viewerId>` / `recv:<userId>`,
   * camera `cam:send:<viewerId>` / `cam:recv:<userId>` (see statsKey in voice.ts).
   */
  streamStats: Record<string, StreamStats>;

  /** Our camera (always off on join; never persisted). */
  cameraStatus: CameraStatus;
  /** Local camera preview stream (the track that is sent); render mirrored. */
  localCamera: MediaStream | null;
  /** Remote camera streams we are receiving, by user. */
  remoteCameras: Record<string, MediaStream>;

  settingsOpen: boolean;
  toasts: Toast[];
}

const initial: AppState = {
  screen: "loading",
  session: null,
  loginNotice: null,
  connection: "connecting",
  retryInMs: undefined,
  fatal: null,
  hasSnapshot: false,
  self: null,
  users: {},
  online: {},
  channels: [],
  voiceStates: {},
  iceServers: [],
  selectedChannelId: null,
  voiceChannelId: null,
  voiceStatus: "idle",
  peers: {},
  speaking: {},
  pttActive: false,
  pttGlobal: false,
  goLiveOpen: false,
  localShare: null,
  focusedStream: null,
  remoteStreams: {},
  streamStats: {},
  cameraStatus: "off",
  localCamera: null,
  remoteCameras: {},
  settingsOpen: false,
  toasts: [],
};

export const useApp = create<AppState>()(() => ({ ...initial }));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

/** Reset everything tied to a logged-in session. */
export function resetSessionState(patch: Partial<AppState> = {}): void {
  const { toasts } = getApp();
  useApp.setState({ ...initial, toasts, ...patch }, true);
}

let toastId = 0;
export function toast(message: string, kind: Toast["kind"] = "info", ttlMs = 5000): void {
  const id = ++toastId;
  setApp((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
  setTimeout(() => dismissToast(id), ttlMs);
}
export function dismissToast(id: number): void {
  setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** Apply a hub frame to the store (voice-call side effects live in voice.ts). */
export function applyServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "ready": {
      const users: Record<string, User> = {};
      for (const u of msg.users) users[u.id] = u;
      users[msg.self.id] = msg.self;
      const online: Record<string, true> = {};
      for (const id of msg.onlineUserIds) online[id] = true;
      online[msg.self.id] = true; // the hub doesn't send our own presence
      const voiceStates: Record<string, VoiceState> = {};
      for (const vs of msg.voiceStates) voiceStates[vs.userId] = vs;
      const channels = sortChannels(msg.channels);
      setApp((s) => ({
        hasSnapshot: true,
        self: msg.self,
        users,
        online,
        channels,
        voiceStates,
        iceServers: msg.iceServers,
        selectedChannelId:
          s.selectedChannelId && channels.some((c) => c.id === s.selectedChannelId)
            ? s.selectedChannelId
            : (channels.find((c) => c.type === "text") ?? channels[0])?.id ?? null,
      }));
      break;
    }
    case "user.upsert":
      setApp((s) => ({ users: { ...s.users, [msg.user.id]: msg.user }, self: s.self?.id === msg.user.id ? msg.user : s.self }));
      break;
    case "presence.update":
      setApp((s) => {
        const online = { ...s.online };
        if (msg.online) online[msg.userId] = true;
        else delete online[msg.userId];
        return { online };
      });
      break;
    case "voice.state":
      setApp((s) => ({ voiceStates: { ...s.voiceStates, [msg.voiceState.userId]: msg.voiceState } }));
      break;
    case "voice.left":
      setApp((s) => {
        const cur = s.voiceStates[msg.userId];
        if (!cur || cur.channelId !== msg.channelId) return {};
        const voiceStates = { ...s.voiceStates };
        delete voiceStates[msg.userId];
        return { voiceStates };
      });
      break;
    case "ice.refresh":
      setApp({ iceServers: msg.iceServers });
      break;
    default:
      break;
  }
}

/** Users in a voice channel, in a stable order. */
export function participantsOf(voiceStates: Record<string, VoiceState>, channelId: string): VoiceState[] {
  return Object.values(voiceStates)
    .filter((v) => v.channelId === channelId)
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

export function displayNameOf(users: Record<string, User>, userId: string): string {
  return users[userId]?.displayName || users[userId]?.username || "Unknown";
}
