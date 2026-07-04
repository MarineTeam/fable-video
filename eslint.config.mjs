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
];

export default config;
