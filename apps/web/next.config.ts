import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Container builds (#64) set NEXT_OUTPUT=standalone: a self-contained server
// traced from the monorepo root. Local `next start` keeps the default output.
const standalone = process.env.NEXT_OUTPUT === "standalone";

const config: NextConfig = {
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@jobflow/authz", "@jobflow/database", "@jobflow/domain"],
  ...(standalone
    ? {
        output: "standalone",
        outputFileTracingRoot: fileURLToPath(
          new URL("../../", import.meta.url),
        ),
      }
    : {}),
};
export default config;
