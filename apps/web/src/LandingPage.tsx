import { ArrowRight, Github } from "lucide-react";
import { useMemo } from "react";
import { PIXEL_SKIN_IDS } from "@relaycode/shared";
import { beginGithubLogin } from "./lib/api";
import { PixelAvatar } from "./PixelCrew";

function randomSkins(count: number): string[] {
  const pool = [...PIXEL_SKIN_IDS];
  const picked: string[] = [];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  }
  return picked;
}

export function LandingPage() {
  const oauthError = new URLSearchParams(window.location.search).get("error");
  const crewSkins = useMemo(() => randomSkins(3), []);
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#faf9f6] px-6 py-20 text-center">
      <div className="pointer-events-none absolute inset-0 [background:radial-gradient(ellipse_70%_55%_at_50%_38%,rgba(24,24,27,.05),transparent_70%)]" />

      <div className="relative flex flex-col items-center gap-7 sm:gap-9">
        <div className="float-down group/logo flex cursor-default items-center gap-4 sm:gap-6">
          <img
            src="/brand/mutex-mark-navy.png"
            alt=""
            className="size-16 shrink-0 rounded-2xl object-cover shadow-[0_20px_45px_rgba(24,24,27,.18)] transition duration-500 ease-out group-hover/logo:-rotate-6 group-hover/logo:scale-110 sm:size-24"
          />
          <span className="text-[56px] font-extrabold leading-none tracking-tight text-zinc-950 sm:text-[88px]">MUTEX</span>
        </div>

        <p className="group/sub max-w-md font-mono text-[13px] font-medium text-zinc-500 sm:text-[15px]">
          <span className="slide-in-left transition-colors duration-200 group-hover/sub:text-zinc-950" style={{ animationDelay: "150ms" }}>lock()</span>
          <span className="slide-in-left mx-2 sm:mx-3" style={{ animationDelay: "230ms" }}>→</span>
          <span className="slide-in-left transition-colors duration-200 group-hover/sub:text-zinc-950" style={{ animationDelay: "310ms" }}>edit()</span>
          <span className="slide-in-left mx-2 sm:mx-3" style={{ animationDelay: "390ms" }}>→</span>
          <span className="slide-in-left transition-colors duration-200 group-hover/sub:text-zinc-950" style={{ animationDelay: "470ms" }}>unlock()</span>
          <span className="slide-in-left ml-2" style={{ animationDelay: "540ms" }}>as a team</span>
        </p>

        <button
          onClick={beginGithubLogin}
          className="float-down group/cta mt-2 flex items-center gap-3 rounded-full bg-signal px-8 py-4 text-[15px] font-bold text-zinc-950 transition duration-300 hover:scale-[1.04] hover:shadow-[0_14px_38px_rgba(241,180,76,.5)] hover:brightness-105 active:scale-[0.98]"
          style={{ animationDelay: "600ms" }}
        >
          <Github size={19} className="transition-transform duration-300 group-hover/cta:-rotate-12" /> Continue with GitHub
          <ArrowRight size={17} className="transition-transform duration-300 group-hover/cta:translate-x-1.5" />
        </button>

        <div className="float-down mt-5 flex items-end gap-6 sm:mt-8 sm:gap-8" style={{ animationDelay: "700ms" }}>
          {crewSkins.map((skinId, index) => (
            <div key={skinId} className="flex cursor-default flex-col items-center gap-2">
              <div className="crew-bob" style={{ animationDelay: `${index * 330}ms`, animationDuration: `${1.7 + index * 0.4}s` }}>
                <PixelAvatar skinId={skinId} size={72} />
              </div>
              <div className="h-1.5 w-9 rounded-full bg-zinc-900/10 blur-[1.5px]" />
            </div>
          ))}
        </div>

        {oauthError && <div className="max-w-sm rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">{oauthError}</div>}
      </div>
    </div>
  );
}
