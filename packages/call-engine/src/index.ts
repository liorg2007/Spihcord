export * from "./types";
import type { CreateVoiceCall } from "./types";
import { VoiceCallImpl } from "./voiceCall";

/** Create a full-mesh WebRTC voice call. Browser (Electron renderer) only. */
export const createVoiceCall: CreateVoiceCall = (options) => new VoiceCallImpl(options);
