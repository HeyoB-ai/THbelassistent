/** @type {import('next').NextConfig} */
const nextConfig = {
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
