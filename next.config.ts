import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @react-pdf/renderer, unpdf and mammoth are Node-only libraries. Keeping them
  // external stops the bundler from trying to inline their font/binary assets.
  serverExternalPackages: ["@react-pdf/renderer", "unpdf", "mammoth"],
};

export default nextConfig;
