import { useEffect, useRef } from "react";
import WatermarkOverlay from "./WatermarkOverlay";

// Wraps the tokenized bunny.net embed with player.js to remember playback
// position per viewer. Degrades gracefully: if the player.js protocol is
// unavailable, plain playback still works — resume simply does nothing.
export default function ResumablePlayer({ src, videoId, watermark }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!videoId || !iframeRef.current) return undefined;
    let disposed = false;
    let saveTimer = null;
    let lastKnown = { t: 0, d: 0 };

    const save = () => {
      if (!lastKnown.d || lastKnown.t < 5) return;
      fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, t: lastKnown.t, d: lastKnown.d }),
        keepalive: true,
      }).catch(() => {});
    };

    (async () => {
      try {
        const mod = await import("player.js");
        const playerjs = mod.default || mod;
        if (disposed || !iframeRef.current) return;
        const player = new playerjs.Player(iframeRef.current);

        player.on("ready", async () => {
          if (disposed) return;
          try {
            const res = await fetch(
              `/api/progress?videoId=${encodeURIComponent(videoId)}`
            );
            const data = res.ok ? await res.json() : null;
            const saved = data?.progress;
            if (saved?.t > 5 && saved?.d && saved.t < saved.d * 0.95) {
              player.setCurrentTime(saved.t);
            }
          } catch {
            // Resume unavailable — playback continues from the start.
          }
          player.on("timeupdate", ({ seconds, duration }) => {
            lastKnown = {
              t: Math.floor(seconds || 0),
              d: Math.floor(duration || 0),
            };
          });
          player.on("pause", save);
          player.on("ended", () => {
            lastKnown = { ...lastKnown, t: lastKnown.d };
            save();
          });
          saveTimer = setInterval(save, 10000);
        });
      } catch {
        // player.js failed to load — plain embed playback still works.
      }
    })();

    return () => {
      disposed = true;
      clearInterval(saveTimer);
      save();
    };
  }, [videoId]);

  return (
    <div className="player-frame">
      <iframe
        ref={iframeRef}
        src={src}
        loading="eager"
        allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        title="Video player"
      />
      <WatermarkOverlay text={watermark} />
    </div>
  );
}
