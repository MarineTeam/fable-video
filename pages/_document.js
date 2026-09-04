import Document, { Html, Head, Main, NextScript } from "next/document";
import { getSiteName } from "../lib/store";
import { shortSiteName } from "../lib/siteName";

// Applies the cached palette before first paint so returning visitors never
// see a color flicker. Must stay in sync with lib/theme-client.js.
const themeBoot = `(function(){try{var raw=localStorage.getItem("fablevideo:theme");if(!raw)return;var t=JSON.parse(raw);if(t&&t.accent&&t.accent2){var s=document.documentElement.style;s.setProperty("--accent",t.accent);s.setProperty("--accent-2",t.accent2);}}catch(e){}})();`;

const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f172a"/><path d="M12 9.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 12 9.5z" fill="#38bdf8"/></svg>'
  );

function MarineDocument({ appleTitle }) {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href={favicon} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0f172a" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* iOS Safari's "Add to Home Screen" reads THIS tag for the
            home-screen label, not the manifest's name/short_name — it needs
            its own resolution so a rename reaches an iOS install too. */}
        <meta name="apple-mobile-web-app-title" content={appleTitle} />
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

// Pages statically generated at BUILD time, not rendered per visit — a Redis
// read here could never reflect a later rename anyway (the HTML is already
// baked), so skip the network call for them rather than let a build-time
// Redis outage (real, or — as in CI — a deliberately unreachable dummy host)
// print a caught-but-alarming error into every build log. Next's automatic
// /404 is the only one in this app; every real page opts out of static
// optimization via getServerSideProps, so this list should stay this short.
const STATICALLY_GENERATED_PATHS = new Set(["/404", "/_error"]);

MarineDocument.getInitialProps = async (ctx) => {
  const initialProps = await Document.getInitialProps(ctx);
  if (STATICALLY_GENERATED_PATHS.has(ctx.pathname)) {
    return { ...initialProps, appleTitle: shortSiteName(null) };
  }
  let appleTitle = shortSiteName(null);
  try {
    appleTitle = shortSiteName(await getSiteName());
  } catch (err) {
    console.error("Could not load the site name for _document:", err);
  }
  return { ...initialProps, appleTitle };
};

export default MarineDocument;
