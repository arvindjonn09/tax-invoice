import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
const config = [
  ...nextVitals,
  ...nextTypescript,
  { settings: { next: { rootDir: "apps/web/" } } },
  {
    ignores: [
      "**/.next/**",
      "**/src/generated/**",
      "**/next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
    ],
  },
];

export default config;
