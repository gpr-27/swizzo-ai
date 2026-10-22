import type { NextConfig } from "next";

import { securityHeaders } from "./src/backend/security/headers";

const nextConfig: NextConfig = {
  // E2E builds go to their own folder (NEXT_DIST_DIR=.next-e2e) so a test build
  // never overwrites the .next a running dev/start server is serving from.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // The UI renders plain <img> (no next/image), so the image optimizer — the
  // target of several Next.js advisories (docs/SECURITY.md §Dependencies) — is off.
  images: {
    unoptimized: true,
    // If next/image is ever switched on, only Swiggy's CDNs may be optimised.
    remotePatterns: [
      { protocol: "https", hostname: "media-assets.swiggy.com" },
      { protocol: "https", hostname: "res.cloudinary.com", pathname: "/swiggy/**" },
      { protocol: "https", hostname: "dineout-media-assets.swiggy.com" },
    ],
  },
  // Source maps: none shipped to browsers (no public source); server maps stay on
  // so production stack traces in the logs point at real lines.
  productionBrowserSourceMaps: false,
  // CSP, HSTS, frame-ancestors, Permissions-Policy… — see src/backend/security/headers.ts
  async headers() {
    return securityHeaders();
  },
};

export default nextConfig;
