import { useState, type FormEvent } from "react";
import { ApiError, DEFAULT_SERVER_URL, login, normalizeServerUrl, register } from "../lib/api";
import { getLastLogin, loginWith } from "../lib/session";
import { useApp } from "../store/app";
import { LogoMark } from "./Icons";

export function LoginScreen() {
  const notice = useApp((s) => s.loginNotice);
  const last = getLastLogin();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState(last?.serverUrl ?? DEFAULT_SERVER_URL);
  const [username, setUsername] = useState(last?.username ?? "");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(serverUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const name = username.trim();
    if (!name) return setError("Enter your username.");
    if (!password) return setError("Enter your password.");
    if (isRegister) {
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(name))
        return setError("Usernames are 2–32 characters: letters, numbers, dot, dash and underscore.");
      if (password.length < 6) return setError("Passwords need at least 6 characters.");
      if (!inviteCode.trim()) return setError("You need an invite code to register.");
    }
    setBusy(true);
    try {
      const res = isRegister
        ? await register(url, name, password, inviteCode.trim())
        : await login(url, name, password);
      await loginWith({ serverUrl: url, token: res.token, user: res.user });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === "invalid_credentials"
            ? "Wrong username or password."
            : err.code === "invalid_invite"
              ? "That invite code is invalid or expired."
              : err.code === "username_taken"
                ? "That username is already taken."
                : err.code === "rate_limited"
                  ? "Too many attempts. Wait a moment and try again."
                  : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-bg" aria-hidden="true" />
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-logo">
          <LogoMark size={44} />
        </div>
        <h1>{isRegister ? "Create an account" : "Welcome back!"}</h1>
        <p className="login-sub">
          {isRegister ? "Join your friends' Shpihcord server with an invite code." : "We're so excited to see you again!"}
        </p>
        {notice && <div className="login-notice">{notice}</div>}

        <label className="field">
          <span className="field-label">Server address</span>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={DEFAULT_SERVER_URL}
            spellCheck={false}
            autoComplete="url"
          />
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus={!username}
            spellCheck={false}
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!!username}
            autoComplete={isRegister ? "new-password" : "current-password"}
          />
        </label>
        {isRegister && (
          <label className="field">
            <span className="field-label">Invite code</span>
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} spellCheck={false} />
          </label>
        )}

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : isRegister ? "Register" : "Log In"}
        </button>

        <div className="login-switch">
          {isRegister ? "Already have an account?" : "Need an account?"}{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(isRegister ? "login" : "register");
              setError(null);
            }}
          >
            {isRegister ? "Log in" : "Register"}
          </button>
        </div>
      </form>
    </div>
  );
}
