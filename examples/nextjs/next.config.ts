import type { NextConfig } from "next";

// The connectd packages ship TypeScript sources.
const config: NextConfig = { transpilePackages: ["@kavishkagaya/connectd", "@kavishkagaya/connectd-sdk", "@kavishkagaya/connectd-runtime", "@kavishkagaya/connectd-connections", "@kavishkagaya/connectd-kernel"] };
export default config;
