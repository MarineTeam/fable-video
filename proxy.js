import { NextResponse } from "next/server";
import { auth0 } from "./lib/auth0";
import { geoRestrictionEnabled, isAllowedCountry } from "./lib/geo";
import { GEO_BLOCKED_HTML } from "./lib/geoBlockedPage";

// Next.js 16 network boundary (replaces middleware.js). Mounts the Auth0 v4
// routes (/auth/login, /auth/logout, /auth/callback, /auth/profile, ...) and
// keeps rolling sessions alive on every request.
export async function proxy(request) {
  if (geoRestrictionEnabled()) {
    const country = request.headers.get("x-vercel-ip-country");
    if (!isAllowedCountry(country)) {
      return new NextResponse(GEO_BLOCKED_HTML, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    // Everything except static assets — the broad matcher is required for
    // rolling sessions to refresh on ordinary page/API traffic. The PWA
    // assets (manifest, service worker, icons) are excluded so they are
    // served cleanly without session-cookie churn.
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png).*)",
  ],
};
