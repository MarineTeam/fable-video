import { useEffect } from "react";

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const RESET_THROTTLE_MS = 5000;

// Signs the user out after 30 minutes of inactivity — protects a portal left
// open on a shared machine. Mounted only when a session exists.
export default function IdleTimeout() {
  useEffect(() => {
    let timer;
    let lastReset = 0;

    const signOut = () => {
      window.location.assign("/auth/logout");
    };

    const reset = () => {
      const now = Date.now();
      if (now - lastReset < RESET_THROTTLE_MS) return;
      lastReset = now;
      clearTimeout(timer);
      timer = setTimeout(signOut, IDLE_MS);
    };

    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((name) =>
      window.addEventListener(name, reset, { passive: true })
    );
    clearTimeout(timer);
    timer = setTimeout(signOut, IDLE_MS);

    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, reset));
    };
  }, []);

  return null;
}
