import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@fleet/ui"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
