import { useEffect, useState } from "react";
import type { Task, User } from "@relaycode/shared";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import { getPixelSkin } from "./pixelCharacters";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function PixelAvatar({
  skinId,
  size = 36,
  className,
  fit = "contain",
}: {
  skinId?: string | null;
  size?: number;
  className?: string;
  /** "contain" letterboxes into a fixed square (good for a uniform picker grid).
   * "natural" renders at the sprite's real aspect ratio so a wrapper that hugs
   * the image (e.g. an online-status dot) lines up with the actual art instead
   * of an invisible padded square around it. */
  fit?: "contain" | "natural";
}) {
  const skin = getPixelSkin(skinId);
  if (fit === "natural") {
    return (
      <img
        src={skin.src}
        alt={skin.label}
        className={className}
        style={{ imageRendering: "pixelated", height: size, width: "auto", display: "block" }}
        draggable={false}
      />
    );
  }
  return (
    <img
      src={skin.src}
      alt={skin.label}
      width={size}
      height={size}
      className={className}
      style={{ imageRendering: "pixelated", width: size, height: size, objectFit: "contain" }}
      draggable={false}
    />
  );
}

type CrewMember = Pick<User, "id" | "name" | "pixelCharacter"> & { present?: boolean };

type Reaction = { kind: "excited"; ts: number };

export function PixelCrew({
  members,
  activeTask,
  projectId,
  socket,
  currentUserId,
}: {
  members: CrewMember[];
  activeTask: Task | null;
  projectId: string;
  socket: AppSocket | null;
  currentUserId: string;
}) {
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { projectId: string; fromUserId: string; targetUserId: string; kind: "excited" }) => {
      if (payload.projectId !== projectId) return;
      setReactions((current) => ({ ...current, [payload.targetUserId]: { kind: payload.kind, ts: Date.now() } }));
      window.setTimeout(() => {
        setReactions((current) => {
          if (!current[payload.targetUserId]) return current;
          const next = { ...current };
          delete next[payload.targetUserId];
          return next;
        });
      }, 900);
    };
    socket.on("MEMBER_INTERACTION", handler);
    return () => {
      socket.off("MEMBER_INTERACTION", handler);
    };
  }, [socket, projectId]);

  if (!members.length) return null;

  const activeUserId = activeTask?.executorUserId ?? null;
  const poseFor = (userId: string): "idle" | "running" | "verifying" | "stuck" => {
    if (!activeTask || userId !== activeUserId) return "idle";
    if (activeTask.status === "VALIDATING") return "verifying";
    if (activeTask.status === "PAUSED") return "stuck";
    return "running";
  };

  const sendInteraction = (targetUserId: string, kind: "excited") => {
    socket?.emit("MEMBER_INTERACTION", { projectId, targetUserId, kind });
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[65] flex items-end gap-2">
      {members.map((member) => {
        const isSelf = member.id === currentUserId;
        const reaction = reactions[member.id];
        const pose = poseFor(member.id);
        const poseClass = reaction
          ? "pixel-pose-excited"
          : pose === "running"
            ? "pixel-pose-running"
            : pose === "verifying"
              ? "pixel-pose-verifying"
              : pose === "stuck"
                ? "pixel-pose-stuck"
                : "pixel-pose-idle";
        return (
          <div key={member.id} className="pointer-events-auto group relative flex flex-col items-center">
            <div
              className={["relative", poseClass, isSelf ? "cursor-pointer" : ""].join(" ")}
              title={isSelf ? "Give yourself a hype jump" : undefined}
              onClick={() => isSelf && sendInteraction(member.id, "excited")}
            >
              <PixelAvatar skinId={member.pixelCharacter} size={72} />
              {member.present !== undefined && (
                <span
                  className={[
                    "absolute bottom-0 right-1 size-2.5 rounded-full ring-2 ring-white",
                    member.present ? "bg-emerald-500" : "bg-zinc-300",
                  ].join(" ")}
                />
              )}
            </div>
            <span className="mt-0.5 max-w-[60px] truncate text-center text-[8px] font-medium text-zinc-500">
              {member.name.split(" ")[0]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
