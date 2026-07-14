import "../styles/globals.css";
import { useEffect } from "react";
import Head from "next/head";
import { Inter } from "next/font/google";
import IdleTimeout from "../components/IdleTimeout";
import { applyResolvedTheme } from "../lib/theme-client";

const inter = Inter({ subsets: ["latin"] });

export default function App({ Component, pageProps }) {
  // Fetch the admin-chosen palette and apply it; the resolved theme is cached
  // in localStorage so _document's pre-paint script prevents color flicker on
  // the next visit.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/theme")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.theme) applyResolvedTheme(data.theme);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Register the service worker so the portal is installable as a PWA. The
  // worker itself only caches static icons (see public/sw.js) — never auth,
  // API data, or tokenized video/thumbnail URLs.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return (
    <div className={inter.className}>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{process.env.NEXT_PUBLIC_SITE_NAME || "Marine Video Portal"}</title>
      </Head>
      {pageProps.user ? <IdleTimeout /> : null}
      <Component {...pageProps} />
    </div>
  );
}
