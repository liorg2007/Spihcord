/**
 * WebRTC IP handling policy (security T2).
 *
 * Chromium's default ("default") puts every interface address into ICE: LAN,
 * virtual adapters, VPN / Tailscale and global IPv6, all handed to peers via
 * the hub. For a hub on the public internet we use
 * "default_public_interface_only": only the default-route interface is used and
 * no private address is exposed (peers see the STUN-mapped public IP, or
 * nothing with "Hide my IP", which relays everything).
 *
 * When the hub itself is loopback / LAN / Tailscale, everyone in the call is on
 * that private network already, and direct connections there need the local
 * addresses (public-only yields no candidates without STUN), so we keep
 * "default". Pure function so it's unit-tested.
 */
import { classifyHost } from "../shared/serverUrl";

export type WebRtcIpPolicy = "default" | "default_public_interface_only";

export function webrtcPolicyForHub(serverUrl: string | null): WebRtcIpPolicy {
  if (!serverUrl) return "default_public_interface_only";
  let host: string;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    return "default_public_interface_only";
  }
  return classifyHost(host) === "public" ? "default_public_interface_only" : "default";
}
