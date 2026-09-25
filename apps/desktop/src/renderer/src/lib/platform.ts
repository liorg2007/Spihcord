/** The main process' PlatformCaps, fetched once and shared by the UI. */
import { useEffect, useState } from "react";
import { platformCaps, type PlatformCaps } from "../../../shared/platform";
import { bridge } from "./bridge";

let capsPromise: Promise<PlatformCaps> | null = null;
let capsValue: PlatformCaps | null = null;

export function getCaps(): Promise<PlatformCaps> {
  capsPromise ??= bridge
    .caps()
    .catch(() => null)
    .then((c) => (capsValue = c ?? platformCaps(bridge.platform, {}, "")));
  return capsPromise;
}

/** null until loaded. */
export function useCaps(): PlatformCaps | null {
  const [caps, setCaps] = useState<PlatformCaps | null>(capsValue);
  useEffect(() => {
    if (!caps) void getCaps().then(setCaps);
  }, [caps]);
  return caps;
}

export const isMac = (): boolean => bridge.platform === "darwin";
/** "Cmd" on macOS, "Ctrl" elsewhere (for shortcut hints). */
export const modKeyLabel = (): string => (isMac() ? "Cmd" : "Ctrl");
