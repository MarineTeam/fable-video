import * as Sentry from "@sentry/nextjs";

// Inert unless a DSN is configured.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
