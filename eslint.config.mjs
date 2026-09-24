import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Effect-driven data fetching is the intended pattern here (Pages
      // Router, no data library): the loaders only call setState after an
      // awaited fetch, but the rule's static analysis cannot see the await
      // boundary and flags them as synchronous setState-in-effect.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // no-undef on server code. eslint-config-next leaves it off for plain JS,
    // so a call to a function nobody imported lints clean and only fails at
    // runtime — the sibling repo shipped exactly that in an API route, where
    // it threw a ReferenceError on every authenticated request while the
    // route-guard tests (anonymous callers only) stayed green.
    //
    // Scoped to lib/ and pages/api/, which run on Node with a small,
    // enumerable global set. Browser code would need the whole DOM global
    // list, which is a different job.
    //
    // NEGATIVE CONTROL (re-run after editing this block): delete an import
    // that a file below actually uses and `npm run lint` must fail with
    // "'<name>' is not defined".
    files: ["lib/**/*.js", "pages/api/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        crypto: "readonly",
        Response: "readonly",
        Request: "readonly",
        structuredClone: "readonly",
        AbortController: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
  {
    // The same rule on browser code. Its absence let a page ship with a
    // reference to a variable from ANOTHER component (`remote`, in the
    // request-access form on pages/index.js, 2026-09-24): lint was clean, and
    // the page threw a ReferenceError for every signed-in person who was not
    // yet approved — the one page they could reach. The globals are listed
    // rather than taken from a package, like the block above, so a new one is
    // a deliberate line here; a missing one fails lint loudly, never silently.
    //
    // NEGATIVE CONTROL: reference an undeclared name in any page or component
    // and `npm run lint` must fail with "'<name>' is not defined".
    files: ["pages/**/*.js", "components/**/*.js"],
    ignores: ["pages/api/**"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        AbortController: "readonly",
        Notification: "readonly",
        Image: "readonly",
        Blob: "readonly",
        File: "readonly",
        FileReader: "readonly",
        FormData: "readonly",
        atob: "readonly",
        btoa: "readonly",
        Intl: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        confirm: "readonly",
        alert: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
];

export default config;
