// Static HTML for the geo-restriction block response, rendered directly from
// proxy.js (the edge network boundary, before any Next.js page/React tree
// exists to render into). Deliberately generic — it never reveals which
// countries are or aren't allowed.
export const GEO_BLOCKED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not available in your region</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e2e8f0;
    background: #0b1220;
    padding: 24px;
  }
  .card {
    max-width: 420px;
    text-align: center;
    padding: 32px;
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    background: rgba(148, 163, 184, 0.06);
  }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { color: #94a3b8; margin: 0; line-height: 1.55; }
</style>
</head>
<body>
  <div class="card">
    <h1>Not available in your region</h1>
    <p>This service isn't available from your current location.</p>
  </div>
</body>
</html>
`;
