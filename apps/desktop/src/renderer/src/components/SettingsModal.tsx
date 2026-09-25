import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PttBinding } from "../../../shared/ipc";
import { bridge } from "../lib/bridge";
import { hostOf } from "../lib/format";
import { startMicTest } from "../lib/micTest";
import { bindingFromKeyboardEvent, bindingFromMouseEvent, refreshPtt, setPttRecording } from "../lib/ptt";
import { useCaps } from "../lib/platform";
import { changePassword, logout, logoutAllDevices } from "../lib/session";
import { ApiError } from "../lib/api";
import { setApp, useApp } from "../store/app";
import { StreamVideo } from "./Stream";
import { useSettings, type Settings } from "../store/settings";
import { Avatar } from "./Avatar";
import { KeyboardIcon, LogoMark, LogOutIcon, MicIcon, ShieldIcon, VideoOffIcon, WarningIcon, XIcon } from "./Icons";

type Tab = "voice" | "account";

export function SettingsModal() {
  const [tab, setTab] = useState<Tab>("voice");
  const [version, setVersion] = useState("");
  const close = useCallback(() => setApp({ settingsOpen: false }), []);

  useEffect(() => {
    void bridge.getVersion().then(setVersion).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.body.dataset.recordingKeybind) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="settings-layer" role="dialog" aria-modal="true" aria-label="User Settings">
      <div className="settings-nav-wrap">
        <nav className="settings-nav">
          <div className="settings-nav-heading">User Settings</div>
          <button className={`settings-nav-item${tab === "account" ? " selected" : ""}`} onClick={() => setTab("account")}>
            My Account
          </button>
          <div className="settings-nav-heading">App Settings</div>
          <button className={`settings-nav-item${tab === "voice" ? " selected" : ""}`} onClick={() => setTab("voice")}>
            Voice &amp; Video
          </button>
          <div className="settings-nav-sep" />
          <button className="settings-nav-item danger" onClick={() => void logout()}>
            Log Out <LogOutIcon size={16} />
          </button>
          <div className="settings-version">
            <LogoMark size={16} /> Shpihcord {version || "…"} · {bridge.platform}
          </div>
        </nav>
      </div>
      <div className="settings-content-wrap">
        <div className="settings-content">{tab === "voice" ? <VoiceSettings /> : <AccountSettings />}</div>
        <div className="settings-close">
          <button className="close-circle" onClick={close} aria-label="Close settings">
            <XIcon size={18} />
          </button>
          <span>ESC</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AccountSettings() {
  const self = useApp((s) => s.self ?? s.session?.user ?? null);
  const serverUrl = useApp((s) => s.session?.serverUrl ?? "");
  const connection = useApp((s) => s.connection);
  if (!self) return null;
  return (
    <section>
      <h2 className="settings-title">My Account</h2>
      <div className="account-card">
        <div className="account-banner" />
        <div className="account-body">
          <div className="account-avatar">
            <Avatar userId={self.id} name={self.displayName || self.username} size={80} />
          </div>
          <div className="account-names">
            <div className="account-name">{self.displayName || self.username}</div>
            <div className="muted">@{self.username}</div>
          </div>
        </div>
        <div className="account-fields">
          <div className="account-field">
            <div className="field-label">Server</div>
            <div>{hostOf(serverUrl)}</div>
          </div>
          <div className="account-field">
            <div className="field-label">Status</div>
            <div className="capitalize">{connection}</div>
          </div>
        </div>
      </div>
      <ChangePassword />
      <div className="settings-divider" />
      <h3 className="settings-subtitle">Sessions</h3>
      <p className="settings-hint">
        “Log out all devices” signs this account out everywhere, including any device that might have your login.
      </p>
      <div className="account-actions">
        <button className="btn btn-danger" onClick={() => void logout()}>
          Log Out
        </button>
        <LogoutAllButton />
      </div>
    </section>
  );
}

function accountErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_credentials" || err.code === "wrong_password") return "Your current password is wrong.";
    if (err.code === "rate_limited") return "Too many attempts. Wait a moment and try again.";
    if (err.code === "http_404") return "This server doesn't support that yet. Ask the admin to update the hub.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function LogoutAllButton() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setError(null);
    logoutAllDevices().catch((err: unknown) => {
      setError(accountErrorText(err));
      setBusy(false);
    });
  };
  return (
    <>
      {confirming ? (
        <span className="account-confirm">
          <button className="btn btn-danger" disabled={busy} onClick={run}>
            {busy ? <span className="spinner" /> : "Yes, log out everywhere"}
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button className="btn btn-secondary" onClick={() => setConfirming(true)}>
          Log out all devices
        </button>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!current) return setError("Enter your current password.");
    if (next.length < 8) return setError("New passwords need at least 8 characters.");
    if (next.length > 128) return setError("New passwords can be at most 128 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    changePassword(current, next).catch((err: unknown) => {
      setError(accountErrorText(err));
      setBusy(false);
    });
  };

  if (!open) {
    return (
      <>
        <div className="settings-divider" />
        <h3 className="settings-subtitle">Password</h3>
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          Change password
        </button>
      </>
    );
  }
  return (
    <>
      <div className="settings-divider" />
      <h3 className="settings-subtitle">Password</h3>
      <form className="change-password" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field-label">Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          <span className="field-label">Confirm new password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        <p className="settings-hint">Changing your password logs out your other devices.</p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="account-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : "Change password"}
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((d) => {
          if (alive) setDevices(d);
        })
        .catch(() => {});
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    // Labels appear once mic access was granted (the mic test does that); refresh shortly after.
    const t = setTimeout(refresh, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, []);
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
    cameras: devices.filter((d) => d.kind === "videoinput"),
  };
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
  fallbackName,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
  fallbackName: string;
}) {
  const hasDefault = devices.some((d) => d.deviceId === "default");
  const known = value === "default" || devices.some((d) => d.deviceId === value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {!hasDefault && <option value="default">Default</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${fallbackName} ${i + 1}`}
            </option>
          ))}
          {!known && <option value={value}>Unavailable device</option>}
        </select>
      </div>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description?: string;
}) {
  return (
    <label className="toggle-row">
      <div className="toggle-text">
        <div className="toggle-title">{title}</div>
        {description && <div className="toggle-desc">{description}</div>}
      </div>
      <input type="checkbox" className="toggle-input" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

function VoiceSettings() {
  const s = useSettings();
  const inCall = useApp((st) => !!st.voiceChannelId);
  const { inputs, outputs, cameras } = useDevices();
  const update = (patch: Partial<Settings>) => s.update(patch);

  return (
    <section>
      <h2 className="settings-title">Voice &amp; Video</h2>

      <div className="settings-grid-2">
        <DeviceSelect
          label="Input Device"
          devices={inputs}
          value={s.inputDeviceId}
          onChange={(id) => update({ inputDeviceId: id })}
          fallbackName="Microphone"
        />
        <DeviceSelect
          label="Output Device"
          devices={outputs}
          value={s.outputDeviceId}
          onChange={(id) => update({ outputDeviceId: id })}
          fallbackName="Speaker"
        />
      </div>

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Input Mode</h3>
      <div className="radio-cards">
        <label className={`radio-card${s.inputMode === "voice-activity" ? " selected" : ""}`}>
          <input
            type="radio"
            name="inputMode"
            checked={s.inputMode === "voice-activity"}
            onChange={() => update({ inputMode: "voice-activity" })}
          />
          <MicIcon size={18} />
          <span>Voice Activity</span>
        </label>
        <label className={`radio-card${s.inputMode === "push-to-talk" ? " selected" : ""}`}>
          <input
            type="radio"
            name="inputMode"
            checked={s.inputMode === "push-to-talk"}
            onChange={() => update({ inputMode: "push-to-talk" })}
          />
          <KeyboardIcon size={18} />
          <span>Push to Talk</span>
        </label>
      </div>

      {s.inputMode === "push-to-talk" && <KeybindRecorder binding={s.pttBinding} onChange={(b) => update({ pttBinding: b })} />}

      <h3 className="settings-subtitle">Input Sensitivity</h3>
      <p className="settings-hint">
        {s.inputMode === "voice-activity"
          ? "Drag the marker: your mic transmits when the level is past it. Talk to test."
          : "In Push to Talk mode the mic only transmits while the key is held. The meter shows your level."}
      </p>
      <MicMeter threshold={s.vadThreshold} onThreshold={(v) => update({ vadThreshold: v })} showThreshold={s.inputMode === "voice-activity"} />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Voice Processing</h3>
      {inCall && <p className="settings-hint">Processing changes apply the next time you join a voice channel.</p>}
      <Toggle
        title="Noise Suppression"
        description="Filters out background noise like fans and keyboards."
        checked={s.noiseSuppression}
        onChange={(v) => update({ noiseSuppression: v })}
      />
      <Toggle
        title="Echo Cancellation"
        description="Stops others from hearing themselves through your speakers."
        checked={s.echoCancellation}
        onChange={(v) => update({ echoCancellation: v })}
      />
      <Toggle
        title="Automatic Gain Control"
        description="Keeps your volume steady whether you whisper or shout."
        checked={s.autoGainControl}
        onChange={(v) => update({ autoGainControl: v })}
      />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Video Settings</h3>
      <CameraPreview deviceId={s.videoDeviceId} />
      <DeviceSelect
        label="Camera"
        devices={cameras}
        value={s.videoDeviceId}
        onChange={(id) => update({ videoDeviceId: id })}
        fallbackName="Camera"
      />
      <Toggle
        title="Don't receive video"
        description="Pause everyone's camera to save bandwidth. You can also hide one person's video from their profile menu."
        checked={s.disableIncomingVideo}
        onChange={(v) => update({ disableIncomingVideo: v })}
      />
      {Object.keys(s.hiddenVideos).length > 0 && (
        <p className="settings-hint">
          Hidden cameras: {Object.keys(s.hiddenVideos).length}.{" "}
          <button className="link" onClick={() => update({ hiddenVideos: {} })}>
            Show all again
          </button>
        </p>
      )}

      <div className="settings-divider" />

      <h3 className="settings-subtitle">
        <ShieldIcon size={16} /> Privacy
      </h3>
      <Toggle
        title="Hide my IP from friends (uses relay)"
        description="Route voice, video and screen share through the server's TURN relay so friends never see your IP address. Without it, direct connections show friends your public IP (local network and VPN addresses are always hidden). May add latency. Applies the next time you join."
        checked={s.forceRelay}
        onChange={(v) => update({ forceRelay: v })}
      />

      <div className="settings-divider" />

      <h3 className="settings-subtitle">Sounds</h3>
      <Toggle
        title="Join, leave and mute sounds"
        checked={s.soundsEnabled}
        onChange={(v) => update({ soundsEnabled: v })}
      />
    </section>
  );
}

function MicMeter({
  threshold,
  onThreshold,
  showThreshold,
}: {
  threshold: number;
  onThreshold: (v: number) => void;
  showThreshold: boolean;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const showRef = useRef(showThreshold);
  showRef.current = showThreshold;

  useEffect(() => {
    setError(null);
    const stop = startMicTest(
      (level) => {
        const el = fillRef.current;
        if (!el) return;
        el.style.width = `${Math.round(level * 1000) / 10}%`;
        el.classList.toggle("active", !showRef.current || level >= thresholdRef.current);
      },
      (msg) => setError(msg),
    );
    return stop;
  }, []);

  const pct = Math.round(threshold * 100);
  return (
    <div className="meter-block">
      <div className={`meter${showThreshold ? "" : " no-threshold"}`}>
        <div className="meter-fill" ref={fillRef} />
        {showThreshold && (
          <input
            type="range"
            className="meter-slider"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => onThreshold(Number(e.target.value) / 100)}
            aria-label="Voice activity threshold"
          />
        )}
      </div>
      <div className="meter-scale">
        <span>-60 dB</span>
        {showThreshold && <span>threshold {Math.round(-60 + threshold * 60)} dB</span>}
        <span>0 dB</span>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function KeybindRecorder({ binding, onChange }: { binding: PttBinding | null; onChange: (b: PttBinding) => void }) {
  const [recording, setRecording] = useState(false);
  const pttGlobal = useApp((s) => s.pttGlobal);
  const [globalAvailable, setGlobalAvailable] = useState<boolean | null>(null);
  const caps = useCaps();
  const [axStatus, setAxStatus] = useState<string>("not-needed");

  useEffect(() => {
    void bridge.ptt.isGlobalAvailable().then(setGlobalAvailable).catch(() => setGlobalAvailable(false));
  }, []);

  // macOS: poll Accessibility while settings are open; re-register once it's granted.
  useEffect(() => {
    if (!caps?.needsAccessibility) return;
    let alive = true;
    let last = "";
    const check = () =>
      void bridge.ptt.accessibility(false).then((st) => {
        if (!alive) return;
        setAxStatus(st);
        if (last && last !== st && st === "granted") refreshPtt();
        last = st;
      });
    check();
    const t = setInterval(check, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [caps]);

  const askAccessibility = () => {
    void bridge.ptt.accessibility(true);
    void bridge.openSystemSettings("accessibility");
  };

  useEffect(() => {
    if (!recording) return;
    let done = false;
    document.body.dataset.recordingKeybind = "1";
    setPttRecording(true);
    const finish = (b: PttBinding | null) => {
      if (done) return;
      done = true;
      setRecording(false);
      if (b && b.code !== "Escape") onChange(b);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(e.code === "Escape" ? null : bindingFromKeyboardEvent(e));
    };
    const onMouse = (e: MouseEvent) => {
      const b = bindingFromMouseEvent(e);
      if (!b) return;
      e.preventDefault();
      finish(b);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    // Keys are recorded from DOM events in this (focused) window only. The global
    // hook is used during recording just for side mouse buttons 4/5, which some
    // mice/drivers never deliver to the page; main only arms it while focused.
    const onBlur = () => finish(null);
    window.addEventListener("blur", onBlur);
    void bridge.ptt.record(15000).then((b) => {
      if (b) finish(b);
    });
    const timeout = setTimeout(() => finish(null), 15000);
    return () => {
      done = true;
      clearTimeout(timeout);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("blur", onBlur);
      bridge.ptt.cancelRecord();
      delete document.body.dataset.recordingKeybind;
      setPttRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <div className="keybind">
      <div className="field-label">Shortcut</div>
      <div className={`keybind-box${recording ? " recording" : ""}`}>
        <span className="keybind-key">{recording ? "Press a key or mouse button…" : (binding?.label ?? "Not set")}</span>
        <button className={`btn ${recording ? "btn-danger" : "btn-secondary"} btn-small`} onClick={() => setRecording((r) => !r)}>
          {recording ? "Cancel" : "Record Keybind"}
        </button>
      </div>
      {axStatus === "denied" && (
        <div className="golive-note warn">
          <WarningIcon size={16} />
          <span>
            Global push-to-talk needs Accessibility access. Allow Shpihcord in System Settings → Privacy &amp; Security →
            Accessibility. Until then, push-to-talk only works while Shpihcord is focused.{" "}
            <button className="btn btn-secondary btn-small" onClick={askAccessibility}>
              Grant Access
            </button>
          </span>
        </div>
      )}
      <p className="settings-hint">
        {caps?.wayland
          ? "Wayland doesn't let apps watch keys globally, so push-to-talk only works while Shpihcord is focused."
          : globalAvailable === false
          ? "Global hotkeys aren't available on this system, so push-to-talk only works while Shpihcord is focused."
          : pttGlobal
            ? "Works everywhere, even while you're in a game."
            : "Push-to-talk works while Shpihcord is focused."}
      </p>
    </div>
  );
}

function cameraErrorText(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? (err as Error).name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access was denied.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is in use by another app.";
  return "Couldn't open the camera.";
}

/**
 * Live, mirrored camera preview. Opens its own capture while the settings are
 * open (stopped on close/device change); if the call's camera is on, shows
 * that stream instead so the device isn't opened twice.
 */
function CameraPreview({ deviceId }: { deviceId: string }) {
  const callCamera = useApp((s) => s.cameraStatus);
  const callStream = useApp((s) => s.localCamera);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const useCall = callCamera !== "off";

  useEffect(() => {
    if (useCall) return;
    let alive = true;
    let own: MediaStream | null = null;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        video: {
          deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      .then((st) => {
        if (!alive) {
          st.getTracks().forEach((t) => t.stop());
          return;
        }
        own = st;
        setStream(st);
      })
      .catch((err: unknown) => {
        if (alive) setError(cameraErrorText(err));
      });
    return () => {
      alive = false;
      own?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [deviceId, useCall]);

  const shown = useCall ? callStream : stream;
  return (
    <div className="camera-preview">
      {shown ? (
        <StreamVideo stream={shown} className="camera-preview-video" />
      ) : (
        <div className="camera-preview-empty">
          {error ? (
            <>
              <VideoOffIcon size={28} />
              <span>{error}</span>
            </>
          ) : (
            <span className="spinner" />
          )}
        </div>
      )}
      {useCall && shown && <span className="camera-preview-tag">In call</span>}
    </div>
  );
}
