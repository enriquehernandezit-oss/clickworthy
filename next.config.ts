import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The admin was reorganized under /admin/photo/* (G2). Redirect the old flat
  // URLs so bookmarks + in-flight links still land in the right place.
  async redirects() {
    const slugs = ["outreach", "samples", "orders", "restaurants", "suppressions", "controls"];
    return [
      ...slugs.map((s) => ({ source: `/admin/${s}`, destination: `/admin/photo/${s}`, permanent: false })),
      ...slugs.map((s) => ({ source: `/admin/${s}/:path*`, destination: `/admin/photo/${s}/:path*`, permanent: false })),
    ];
  },
};

export default nextConfig;
