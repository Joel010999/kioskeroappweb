import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@whiskeysockets/baileys", "pino"],
};

export default nextConfig;
