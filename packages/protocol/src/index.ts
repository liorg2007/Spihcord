/**
 * Shared contract between the hub server and the desktop client.
 * Every WebSocket frame is a JSON object with a `type` discriminator,
 * validated with zod on the receiving side.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["text", "voice"]),
  position: z.number().int(),
});
export type Channel = z.infer<typeof ChannelSchema>;

/** Where a user is in voice and their self-reported mic state. */
export const VoiceStateSchema = z.object({
  userId: z.string(),
  channelId: z.string(),
  muted: z.boolean(),
  deafened: z.boolean(),
  /** User is sharing their screen (viewers opt in with a `stream` signal). */
  streaming: z.boolean(),
  /** User's camera is on (sent to everyone in the channel automatically). */
  video: z.boolean(),
});
export type VoiceState = z.infer<typeof VoiceStateSchema>;

/** Mirror of the browser RTCIceServer shape. */
export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServerSchema>;

/**
 * Opaque WebRTC signaling payload, relayed verbatim by the hub.
 * Perfect-negotiation style: either a session description or an ICE candidate.
 */
export const MAX_SDP_LENGTH = 32 * 1024;
export const MAX_CANDIDATE_LENGTH = 1024;

export const SignalDataSchema = z.union([
  z.object({
    kind: z.literal("description"),
    description: z.object({
      type: z.enum(["offer", "answer", "pranswer", "rollback"]),
      /** Bounded (security B3); real SDPs with audio+video+screen are a few KB. */
      sdp: z.string().max(MAX_SDP_LENGTH).optional(),
    }),
  }),
  z.object({
    kind: z.literal("candidate"),
    candidate: z
      .object({
        candidate: z.string().max(MAX_CANDIDATE_LENGTH),
        sdpMid: z.string().max(256).nullable().optional(),
        sdpMLineIndex: z.number().nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .nullable(),
  }),
  /** Viewer -> sharer: start/stop sending me your screen share. */
  z.object({
    kind: z.literal("stream"),
    action: z.enum(["watch", "unwatch"]),
  }),
  /** Viewer -> sender: how much of your camera I want (tile size / visibility). */
  z.object({
    kind: z.literal("video-pref"),
    camera: z.enum(["off", "low", "high"]),
  }),
]);
export type SignalData = z.infer<typeof SignalDataSchema>;

// ---------------------------------------------------------------------------
// HTTP API  (JSON, base path /api)
// ---------------------------------------------------------------------------
//
// POST /api/register  RegisterRequest -> AuthResponse     (requires invite code)
// POST /api/login     LoginRequest    -> AuthResponse
// GET  /api/health    -> { ok: true, protocolVersion }
// POST /api/invites   (Authorization: Bearer <token>, admin only) -> { code }
// POST /api/logout               (Bearer) -> OkResponse         revokes this token
// POST /api/sessions/revoke-all  (Bearer) -> OkResponse         revokes every token of the account
// POST /api/password  (Bearer) ChangePasswordRequest -> AuthResponse
//                     revokes all OTHER sessions; returns the (still valid) caller token + user
// Revoked tokens' live WebSockets are closed with code 4001.
// Errors: HTTP 4xx with ErrorResponse body.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const RegisterRequestSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  inviteCode: z.string().min(1),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** Body of POST /api/logout and /api/sessions/revoke-all. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(), // machine code, e.g. "invalid_credentials"
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------
// WebSocket  (path /ws)
// ---------------------------------------------------------------------------
//
// 1. Client connects and must send `auth` within 10s.
// 2. Hub replies `ready` with a full snapshot (or `error` + close on failure,
//    e.g. code "outdated_client" when protocolVersion mismatches).
// 3. Hub sends `ping` every 25s; client answers `pong`.
//
// Close codes: 4001 unauthorized, 4002 outdated_client, 4003 session_replaced,
// 4004 auth_timeout, 4008 rate limited, 1001 server shutdown.

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string(), protocolVersion: z.number().int() }),
  z.object({ type: z.literal("pong") }),
  /** Join (or switch to) a voice channel. Leaves the previous one implicitly. */
  z.object({ type: z.literal("voice.join"), channelId: z.string() }),
  z.object({ type: z.literal("voice.leave") }),
  z.object({
    type: z.literal("voice.update"),
    muted: z.boolean(),
    deafened: z.boolean(),
    /** Omitted = unchanged. */
    streaming: z.boolean().optional(),
    /** Camera on/off. Omitted = unchanged. */
    video: z.boolean().optional(),
  }),
  /** Relay a WebRTC signal to another user in the same voice channel. */
  z.object({ type: z.literal("rtc.signal"), to: z.string(), data: SignalDataSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    self: UserSchema,
    users: z.array(UserSchema),
    onlineUserIds: z.array(z.string()),
    channels: z.array(ChannelSchema),
    voiceStates: z.array(VoiceStateSchema),
    /** STUN + TURN (with ephemeral credentials) for RTCPeerConnection. */
    iceServers: z.array(IceServerSchema),
  }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("user.upsert"), user: UserSchema }),
  z.object({ type: z.literal("presence.update"), userId: z.string(), online: z.boolean() }),
  /** A user joined / switched / changed mute state in voice. */
  z.object({ type: z.literal("voice.state"), voiceState: VoiceStateSchema }),
  /** A user left voice (explicitly or by disconnecting). */
  z.object({ type: z.literal("voice.left"), userId: z.string(), channelId: z.string() }),
  z.object({ type: z.literal("rtc.signal"), from: z.string(), data: SignalDataSchema }),
  /** Fresh TURN credentials before the old ones expire. */
  z.object({ type: z.literal("ice.refresh"), iceServers: z.array(IceServerSchema) }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
