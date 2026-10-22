import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/backend/config/session";
import { AuthHintProvider } from "@/frontend/state/authHint";
import Script from "next/script";
import "./globals.css";

const VERCEL_ANALYTICS =
  process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "1" || process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "true";

// Display serif (Copernicus / Tiempos Headline analog) — warm, literary.
// `display: "swap"` so the wordmark/headlines paint instantly in the fallback
// serif and swap in with no invisible-text flash.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// Humanist body sans (StyreneB analog).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
});

// Mono for code / numeric chrome (used by Markdown `code`/`pre`).
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Swizzo — your thinking concierge",
    template: "%s · Swizzo",
  },
  description:
    "A premium chat concierge for Swiggy. Ask for anything across Instamart, Food, Dineout and Scenes; Swizzo finds the best picks, builds your cart and books your table or tickets.",
  applicationName: "Swizzo",
  authors: [{ name: "Swizzo" }],
  keywords: ["Swizzo", "Swiggy", "Instamart", "Food", "Dineout", "Scenes", "grocery", "concierge", "chat"],
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // Cream in light, deep warm ink in the opt-in dark theme — keeps the browser
  // chrome on-brand on mobile.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#16140f" },
  ],
  // Both schemes are supported; the active one is chosen by html[data-theme]
  // (globals.css sets `color-scheme` per theme so native controls match).
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  // Let the layout extend under the iOS home indicator; the composer pads itself
  // with env(safe-area-inset-bottom).
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The inline no-flash script below sets data-theme on <html> BEFORE React
      // hydrates, so the attribute legitimately differs from the server HTML.
      // suppressHydrationWarning scopes React's tolerance to THIS element only.
      suppressHydrationWarning
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        {/* Apply the saved (or OS) theme BEFORE first paint so a remembered dark
            theme never flashes light. Mirrors ThemeToggle's reconciliation. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('swiggy-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.dataset.theme='dark';}var c=t==='dark'?'#16140f':'#faf9f5';document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute('content',c);});}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full bg-canvas font-sans text-body">
        {/* No session cookie → the page can server-render the login gate. */}
        <AuthHintProvider hasSession={(await cookies()).has(SESSION_COOKIE)}>
          {children}
        </AuthHintProvider>
        {/* Vercel Web Analytics + Speed Insights (enable both in the Vercel project,
            then set NEXT_PUBLIC_VERCEL_ANALYTICS=1). Same-origin scripts, no package. */}
        {VERCEL_ANALYTICS && (
          <>
            <Script src="/_vercel/insights/script.js" strategy="afterInteractive" />
            <Script src="/_vercel/speed-insights/script.js" strategy="afterInteractive" />
          </>
        )}
      </body>
    </html>
  );
}
