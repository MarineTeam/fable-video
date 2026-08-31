// Minimal test harness for Next.js Pages-Router API routes.
//
// The repo had no route coverage at all — lint and build were the only
// automated checks on every /api/** handler, so guard ordering, status codes,
// and response shapes were unverified. These helpers make a route callable
// from Vitest without a server: build a fake req/res pair, await the handler,
// then assert on what it wrote.
//
// `res` records instead of sending, and mirrors just enough of the Node
// ServerResponse surface for these handlers: status(), json(), setHeader(),
// and the headersSent flag that lib/monitor.js's wrapper checks.
//
// Not included here (deliberately): this file lives under lib/__tests__/ but
// is not itself a *.test.js file, so vitest's include pattern skips it.

export function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
      return res;
    },
    getHeader(name) {
      return res.headers[String(name).toLowerCase()];
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

export function mockReq({ method = "GET", body = {}, query = {}, headers = {} } = {}) {
  return { method, body, query, headers, url: "/" };
}

// Calls a route handler and returns the recorded response.
export async function callRoute(handler, options = {}) {
  const req = mockReq(options);
  const res = mockRes();
  await handler(req, res);
  return res;
}
