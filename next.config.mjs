import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // De gedeelde bestanden (lib, relay, survey) importeren elkaar met een
  // .js-extensie, want de worker draait als NodeNext-ESM en eist die extensie.
  // Next/webpack moet die .js dan naar de echte .ts laten wijzen.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },

  // Deze map is de root — niet de package-lock.json van de home-directory.
  outputFileTracingRoot: __dirname,

  // Het dashboard mag nooit geïndexeerd worden. De authenticatie zit in
  // src/middleware.ts; dit is de extra noindex-header (Netlify zet 'm ook,
  // maar zo klopt het ook op `next dev` en andere hosts).
  async headers() {
    return [
      {
        source: "/dashboard/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/dashboard",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
