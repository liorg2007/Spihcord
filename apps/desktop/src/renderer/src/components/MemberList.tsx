import { useMemo } from "react";
import type { User } from "@shpihcord/protocol";
import { useApp } from "../store/app";
import { Avatar } from "./Avatar";
import { SpeakerIcon } from "./Icons";
import { popoverTriggerProps } from "./UserPopover";

export function MemberList() {
  const users = useApp((s) => s.users);
  const online = useApp((s) => s.online);
  const { on, off } = useMemo(() => {
    const all = Object.values(users).sort((a, b) =>
      (a.displayName || a.username).localeCompare(b.displayName || b.username, undefined, { sensitivity: "base" }),
    );
    return { on: all.filter((u) => online[u.id]), off: all.filter((u) => !online[u.id]) };
  }, [users, online]);

  return (
    <aside className="members">
      <div className="members-group">Online — {on.length}</div>
      {on.map((u) => (
        <MemberRow key={u.id} user={u} online />
      ))}
      {off.length > 0 && <div className="members-group">Offline — {off.length}</div>}
      {off.map((u) => (
        <MemberRow key={u.id} user={u} online={false} />
      ))}
    </aside>
  );
}

function MemberRow({ user, online }: { user: User; online: boolean }) {
  const selfId = useApp((s) => s.self?.id);
  const voiceChannel = useApp((s) => {
    const vs = s.voiceStates[user.id];
    return vs ? s.channels.find((c) => c.id === vs.channelId)?.name : undefined;
  });
  const inMyCall = useApp((s) => !!s.voiceChannelId && s.voiceStates[user.id]?.channelId === s.voiceChannelId);
  const speaking = useApp((s) => inMyCall && !!s.speaking[user.id]);
  const name = user.displayName || user.username;
  return (
    <div className={`member${online ? "" : " offline"}`} {...popoverTriggerProps(user.id, user.id !== selfId)}>
      <Avatar userId={user.id} name={name} size={32} status={online ? "online" : "offline"} speaking={speaking} />
      <div className="member-names">
        <div className="member-name">{name}</div>
        {voiceChannel && (
          <div className="member-activity">
            <SpeakerIcon size={12} /> {voiceChannel}
          </div>
        )}
      </div>
    </div>
  );
}
