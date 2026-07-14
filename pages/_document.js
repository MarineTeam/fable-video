import { Html, Head, Main, NextScript } from "next/document";

// Applies the cached palette before first paint so returning visitors never
// see a color flicker. Must stay in sync with lib/theme-client.js.
const themeBoot = `(function(){try{var raw=localStorage.getItem("fablevideo:theme");if(!raw)return;var t=JSON.parse(raw);if(t&&t.accent&&t.accent2){var s=document.documentElement.style;s.setProperty("--accent",t.accent);s.setProperty("--accent-2",t.accent2);}}catch(e){}})();`;

const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f172a"/><path d="M12 9.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 12 9.5z" fill="#38bdf8"/></svg>'
  );

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href={favicon} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0f172a" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Marine" />
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
