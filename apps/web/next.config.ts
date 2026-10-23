import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@jobflow/authz", "@jobflow/database", "@jobflow/domain"],
};
export default config;
