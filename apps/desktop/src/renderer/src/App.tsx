import { useEffect } from "react";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { FatalScreen } from "./components/FatalScreen";
import { LogoMark } from "./components/Icons";
import { LoginScreen } from "./components/LoginScreen";
import { MainArea } from "./components/MainArea";
import { MemberList } from "./components/MemberList";
import { ServerRail } from "./components/ServerRail";
import { SettingsModal } from "./components/SettingsModal";
import { Toasts } from "./components/Toasts";
import { UserPopover } from "./components/UserPopover";
import { initPtt } from "./lib/ptt";
import { bootstrap, logout, reconnectNow } from "./lib/session";
import { useApp } from "./store/app";
import { useSettings } from "./store/settings";

export function App() {
  const screen = useApp((s) => s.screen);

  useEffect(() => {
    initPtt();
    void bootstrap();
  }, []);

  return (
    <>
      {screen === "loading" && <Splash text="Starting…" />}
      {screen === "login" && <LoginScreen />}
      {screen === "app" && <AppShell />}
      <Toasts />
    </>
  );
}

function Splash({ text, sub, actions }: { text: string; sub?: string; actions?: boolean }) {
  return (
    <div className="splash">
      <div className="splash-logo">
        <LogoMark size={44} />
      </div>
      <div className="splash-text">{text}</div>
      {sub && <div className="splash-sub">{sub}</div>}
      {actions && (
        <div className="splash-actions">
          <button className="link" onClick={reconnectNow}>
            Retry now
          </button>
          <span className="muted">·</span>
          <button className="link" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectingSplash() {
  const connection = useApp((s) => s.connection);
  const retryInMs = useApp((s) => s.retryInMs);
  const host = useApp((s) => s.session?.serverUrl ?? "");
  const sub =
    connection === "reconnecting"
      ? `Can't reach ${host}.${retryInMs ? ` Retrying in ${Math.max(1, Math.round(retryInMs / 1000))}s…` : " Retrying…"}`
      : host;
  return <Splash text="Connecting to your server…" sub={sub} actions={connection === "reconnecting"} />;
}

function AppShell() {
  const hasSnapshot = useApp((s) => s.hasSnapshot);
  const fatal = useApp((s) => s.fatal);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const showMembers = useSettings((s) => s.showMemberList);

  if (fatal) return <FatalScreen fatal={fatal} />;
  if (!hasSnapshot) return <ConnectingSplash />;

  return (
    <div className={`shell${showMembers ? "" : " no-members"}`}>
      <ServerRail />
      <ChannelSidebar />
      <MainArea />
      {showMembers && <MemberList />}
      <UserPopover />
      {settingsOpen && <SettingsModal />}
    </div>
  );
}
