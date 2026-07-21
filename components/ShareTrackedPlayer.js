import { useEffect, useRef } from "react";
import WatermarkOverlay from "./WatermarkOverlay";

// Wraps the tokenized bunny.net embed with player.js to report real
// playback — not just the page-load "view" already stamped server-side —
// for a private share link: a "play" event on first playback, periodic
// furthest-watched-percent updates, and a completion stamp on "ended".
// Degrades gracefully: if player.js is unavailable, plain playback still
// works, just without playback tracking.
export default function ShareTrackedPlayer({ src, shareId, watermark }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!shareId || !iframeRef.current) return undefined;
    let disposed = false;
    let progressTimer = null;
    let started = false;
    let furthest = 0;

    const track = (event, percent) => {
      fetch("/api/share-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, event, percent }),
        keepalive: true,
      }).catch(() => {});
    };

    (async () => {
      try {
        const mod = await import("player.js");
        const playerjs = mod.default || mod;
        if (disposed || !iframeRef.current) return;
        const player = new playerjs.Player(iframeRef.current);

        player.on("ready", () => {
          if (disposed) return;
          player.on("timeupdate", ({ seconds, duration }) => {
            if (!duration) return;
            furthest = Math.max(furthest, (seconds / duration) * 100);
          });
          player.on("play", () => {
            if (started) return;
            started = true;
            track("play");
          });
          player.on("pause", () => {
            if (furthest > 0) track("progress", furthest);
          });
          player.on("ended", () => track("ended", 100));
          progressTimer = setInterval(() => {
            if (furthest > 0) track("progress", furthest);
          }, 15000);
        });
      } catch {
        // player.js failed to load — plain embed playback still works.
      }
    })();

    return () => {
      disposed = true;
      clearInterval(progressTimer);
    };
  }, [shareId]);

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
