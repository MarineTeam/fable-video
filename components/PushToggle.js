import { useEffect, useState } from "react";

// Public VAPID key is inlined at build time; the feature is inert without it.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// The browser's applicationServerKey must be a Uint8Array of the URL-safe
// base64 VAPID public key.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// "loading" | "unsupported" | "denied" | "off" | "on" | "busy"
export default function PushToggle() {
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (
      !VAPID_PUBLIC_KEY ||
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  const enable = async () => {
    setError("");
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription }),
      });
      if (!res.ok) throw new Error("Could not register for notifications");
      setState("on");
    } catch (err) {
      setError(err.message || "Could not enable notifications");
      setState("off");
    }
  };

  const disable = async () => {
    setError("");
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {});
        await subscription.unsubscribe().catch(() => {});
      }
      setState("off");
    } catch {
      setState("on");
    }
  };

  if (state === "loading" || state === "unsupported") return null;

  if (state === "denied") {
    return (
      <span className="user-chip" title="Notifications are blocked in your browser settings">
        🔕 Blocked
      </span>
    );
  }

  const on = state === "on";
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={state === "busy"}
      onClick={on ? disable : enable}
      title={error || (on ? "Turn off notifications" : "Get notified about new videos")}
    >
      {on ? "🔔 Notifications on" : "🔔 Notify me"}
    </button>
  );
}
