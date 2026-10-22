// HTTP security headers, applied to every response via next.config.ts `headers()`.
// Kept free of app imports so next.config can load it at build time.
//
// CSP notes
// - script-src needs 'unsafe-inline': the App Router streams its RSC payload in
//   inline <script> tags and layout.tsx has a tiny inline no-flash theme script.
//   A nonce-based CSP would need a proxy (middleware) and would force every
//   page to render dynamically. 'unsafe-eval' is only allowed in development
//   (React Fast Refresh); production never gets it.
// - img-src: Swiggy's media CDNs (media-assets / dineout-media-assets /
//   instamart… all under *.swiggy.com), Cloudinary (Swiggy's image origin),
//   data:/blob: (QR codes, photo previews).
// - connect-src 'self': the browser only talks to our /api routes.
// - frame-ancestors 'none' (+ X-Frame-Options DENY) against clickjacking.

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export function contentSecurityPolicy(env: NodeJS.ProcessEnv = process.env): string {
  const dev = env.NODE_ENV !== "production";
  const preview = env.VERCEL_ENV === "preview";
  const vercelLive = preview ? " https://vercel.live https://*.vercel.live" : "";
  const directives: Record<string, string> = {
    "default-src": "'self'",
    "script-src": `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}${vercelLive}`,
    "style-src": `'self' 'unsafe-inline'${vercelLive}`,
    "img-src": `'self' data: blob: https://*.swiggy.com https://*.swiggystatic.com https://res.cloudinary.com${vercelLive}`,
    "font-src": `'self' data:${vercelLive}`,
    "connect-src": `'self'${dev ? " ws: wss:" : ""}${preview ? " https://vercel.live wss://ws-us3.pusher.com" : ""}`,
    "media-src": "'self' blob:",
    "worker-src": "'self' blob:",
    "manifest-src": "'self'",
    "frame-src": preview ? "https://vercel.live" : "'none'",
    "object-src": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
    "frame-ancestors": "'none'",
  };
  let csp = Object.entries(directives)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
  if (!dev) csp += "; upgrade-insecure-requests";
  return csp;
}

export function securityHeaders(env: NodeJS.ProcessEnv = process.env): HeaderRule[] {
  const prod = env.NODE_ENV === "production";
  const common = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // microphone: voice input (SpeechRecognition); camera: photo capture on mobile.
    {
      key: "Permissions-Policy",
      value:
        "microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    ...(prod ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  ];
  return [
    { source: "/:path*", headers: common },
    {
      // API responses are per-user JSON: never embeddable cross-origin. (Cache-Control
      // is set per response by the route wrapper, so streams keep their own.)
      source: "/api/:path*",
      headers: [{ key: "Cross-Origin-Resource-Policy", value: "same-origin" }],
    },
  ];
}
