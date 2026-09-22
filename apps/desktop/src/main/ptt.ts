/**
 * Global push-to-talk via uiohook-napi (a system-wide keyboard/mouse hook), so
 * PTT works while another app (e.g. a game) has focus. Loaded lazily; if the
 * native module is missing or fails to start, the renderer falls back to
 * window-focused keydown/keyup.
 */
import { createRequire } from "node:module";
import type { PttBinding, PttRegisterResult } from "../shared/ipc";

type UiohookModule = typeof import("uiohook-napi");
type Hook = UiohookModule["uIOhook"];

interface KeyEventLike {
  keycode: number;
}
interface MouseEventLike {
  button: unknown;
}

const nodeRequire = createRequire(import.meta.url);

let mod: UiohookModule | null = null;
let loadError: string | undefined;
let hook: Hook | null = null;
let hookRunning = false;

/** DOM KeyboardEvent.code -> uiohook keycode, built from UiohookKey names. */
const domToUio = new Map<string, number>();
const uioToDom = new Map<number, string>();

function domCodeForUiohookName(name: string): string {
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  switch (name) {
    case "Ctrl": return "ControlLeft";
    case "CtrlRight": return "ControlRight";
    case "Alt": return "AltLeft";
    case "Shift": return "ShiftLeft";
    case "Meta": return "MetaLeft";
    default: return name; // F1..F24, ArrowUp, Numpad*, Semicolon, Backquote, ...
  }
}

function load(): UiohookModule | null {
  if (mod || loadError) return mod;
  try {
    mod = nodeRequire("uiohook-napi") as UiohookModule;
    for (const [name, code] of Object.entries(mod.UiohookKey)) {
      const dom = domCodeForUiohookName(name);
      domToUio.set(dom, code as number);
      if (!uioToDom.has(code as number)) uioToDom.set(code as number, dom);
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    console.warn("[ptt] uiohook-napi unavailable, falling back to window PTT:", loadError);
    mod = null;
  }
  return mod;
}

export function isGlobalPttAvailable(): boolean {
  return load() !== null;
}

// DOM MouseEvent.button: 1 middle, 3 back, 4 forward. uiohook: 3 middle, 4 X1, 5 X2.
const MOUSE_DOM_TO_UIO: Record<string, number> = { Mouse3: 3, Mouse4: 4, Mouse5: 5 };
const MOUSE_UIO_TO_DOM: Record<number, string> = { 3: "Mouse3", 4: "Mouse4", 5: "Mouse5" };

function labelFor(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Mouse3") return "Middle Mouse";
  if (code === "Mouse4") return "Mouse 4";
  if (code === "Mouse5") return "Mouse 5";
  return code.replace(/Left$/, "").replace(/Right$/, " (R)");
}

type Target = { kind: "key"; keycode: number } | { kind: "mouse"; button: number };

let target: Target | null = null;
let pressed = false;
let onStateChange: ((pressed: boolean) => void) | null = null;
let recorder: ((binding: PttBinding | null) => void) | null = null;
let recordTimer: NodeJS.Timeout | null = null;

function handleKeyDown(e: KeyEventLike): void {
  if (recorder) {
    const code = uioToDom.get(e.keycode) ?? `Uiohook${e.keycode}`;
    finishRecord({ code, label: uioToDom.has(e.keycode) ? labelFor(code) : `Key ${e.keycode}` });
    return;
  }
  if (target?.kind === "key" && e.keycode === target.keycode) setPressed(true);
}
function handleKeyUp(e: KeyEventLike): void {
  if (target?.kind === "key" && e.keycode === target.keycode) setPressed(false);
}
function handleMouseDown(e: MouseEventLike): void {
  const button = Number(e.button);
  if (recorder) {
    const code = MOUSE_UIO_TO_DOM[button];
    if (code) finishRecord({ code, label: labelFor(code) });
    return;
  }
  if (target?.kind === "mouse" && button === target.button) setPressed(true);
}
function handleMouseUp(e: MouseEventLike): void {
  if (target?.kind === "mouse" && Number(e.button) === target.button) setPressed(false);
}

function setPressed(next: boolean): void {
  if (pressed === next) return; // swallow key-repeat
  pressed = next;
  onStateChange?.(next);
}

function ensureHook(): string | undefined {
  const m = load();
  if (!m) return loadError ?? "uiohook-napi not available";
  if (!hook) {
    hook = m.uIOhook;
    hook.on("keydown", handleKeyDown);
    hook.on("keyup", handleKeyUp);
    hook.on("mousedown", handleMouseDown);
    hook.on("mouseup", handleMouseUp);
  }
  if (!hookRunning) {
    try {
      hook.start();
      hookRunning = true;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

function stopHookIfIdle(): void {
  if (hook && hookRunning && !target && !recorder) {
    try {
      hook.stop();
    } catch {
      /* ignore */
    }
    hookRunning = false;
  }
}

export function setPttStateListener(listener: (pressed: boolean) => void): void {
  onStateChange = listener;
}

export function setPttBinding(binding: PttBinding | null): PttRegisterResult {
  if (pressed) setPressed(false);
  target = null;
  if (!binding) {
    stopHookIfIdle();
    return { global: false };
  }
  const mouse = MOUSE_DOM_TO_UIO[binding.code];
  const uioMatch = /^Uiohook(\d+)$/.exec(binding.code);
  if (!load()) return { global: false, reason: loadError };
  const keycode = uioMatch ? Number(uioMatch[1]) : domToUio.get(binding.code);
  if (mouse !== undefined) target = { kind: "mouse", button: mouse };
  else if (keycode !== undefined) target = { kind: "key", keycode };
  else return { global: false, reason: `Key ${binding.code} can't be watched globally` };

  const err = ensureHook();
  if (err) {
    target = null;
    return { global: false, reason: err };
  }
  return { global: true };
}

function finishRecord(binding: PttBinding | null): void {
  const r = recorder;
  recorder = null;
  if (recordTimer) clearTimeout(recordTimer);
  recordTimer = null;
  stopHookIfIdle();
  r?.(binding);
}

export function recordPttBinding(timeoutMs = 15000): Promise<PttBinding | null> {
  finishRecord(null); // cancel a previous recording
  const err = ensureHook();
  if (err) {
    stopHookIfIdle();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    recorder = resolve;
    recordTimer = setTimeout(() => finishRecord(null), Math.max(1000, Math.min(timeoutMs, 60000)));
  });
}

export function cancelPttRecord(): void {
  finishRecord(null);
}

export function shutdownPtt(): void {
  target = null;
  finishRecord(null);
  if (hook && hookRunning) {
    try {
      hook.stop();
    } catch {
      /* ignore */
    }
    hookRunning = false;
  }
}
