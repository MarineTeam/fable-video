import { useEffect, useRef, useState } from "react";
import WatermarkOverlay from "./WatermarkOverlay";
import { formatTimestamp } from "../lib/chapters";

// Wraps the tokenized bunny.net embed with player.js to remember playback
// position per viewer, and to let a chapter click seek straight to a point in
// a long recording. Degrades gracefully: if the player.js protocol is
// unavailable, plain playback still works — resume simply does nothing and
// the chapter list renders as plain, non-clickable text rather than as
// buttons that would do nothing when pressed.
export default function ResumablePlayer({ src, videoId, watermark, chapters }) {
  const iframeRef = useRef(null);
  const playerRef = useRef(null);
  const [seekable, setSeekable] = useState(false);
  const list = Array.isArray(chapters) ? chapters : [];

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
          playerRef.current = player;
          setSeekable(true);
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
        // player.js failed to load — plain embed playback still works, and
        // the chapter list stays non-interactive rather than lying about it.
      }
    })();

    return () => {
      disposed = true;
      playerRef.current = null;
      clearInterval(saveTimer);
      save();
    };
  }, [videoId]);

  const seek = (seconds) => {
    const player = playerRef.current;
    if (!player) return;
    try {
      player.setCurrentTime(seconds);
      player.play();
    } catch {
      // A seek that the embed refuses is not worth breaking the page over.
    }
  };

  return (
    <>
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
      {list.length ? (
        <div className="chapters card">
          <h2 className="chapters-title">Chapters</h2>
          <ol className="chapter-list">
            {list.map((chapter, index) => (
              <li key={`${chapter.t}-${index}`} className="chapter-row">
                {seekable ? (
                  <button
                    type="button"
                    className="chapter-btn"
                    onClick={() => seek(chapter.t)}
                  >
                    <span className="chapter-time">{formatTimestamp(chapter.t)}</span>
                    <span className="chapter-label">{chapter.label}</span>
                  </button>
                ) : (
                  <span className="chapter-static">
                    <span className="chapter-time">{formatTimestamp(chapter.t)}</span>
                    <span className="chapter-label">{chapter.label}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}
