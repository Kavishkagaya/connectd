import type { NextConfig } from "next";

// The connectd packages ship TypeScript sources.
const config: NextConfig = { transpilePackages: ["@connectd/sdk", "@connectd/runtime", "@connectd/connections", "@connectd/kernel"] };
export default config;
