// Deterrent visual overlay (viewer email + timestamp) tiled across the
// player frame — not DRM, just a re-share deterrent, matching this app's
// existing "no permanent/public URL" content-protection posture. Renders
// nothing when text is falsy.
const TILE_POSITIONS = [
  { top: "18%", left: "12%" },
  { top: "18%", left: "62%" },
  { top: "50%", left: "37%" },
  { top: "82%", left: "12%" },
  { top: "82%", left: "62%" },
];

export default function WatermarkOverlay({ text }) {
  if (!text) return null;
  return (
    <div className="watermark-overlay" aria-hidden="true">
      {TILE_POSITIONS.map((pos, i) => (
        <span key={i} style={pos}>
          {text}
        </span>
      ))}
    </div>
  );
}
