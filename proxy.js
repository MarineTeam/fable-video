import { auth0 } from "./lib/auth0";

// Next.js 16 network boundary (replaces middleware.js). Mounts the Auth0 v4
// routes (/auth/login, /auth/logout, /auth/callback, /auth/profile, ...) and
// keeps rolling sessions alive on every request.
export async function proxy(request) {
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    // Everything except static assets — the broad matcher is required for
    // rolling sessions to refresh on ordinary page/API traffic.
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
