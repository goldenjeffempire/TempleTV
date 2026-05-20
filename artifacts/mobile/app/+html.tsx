import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

const SITE_URL = "https://templetv.org.ng";
const DESCRIPTION =
  "Temple TV — Stream live worship, sermons, and teachings from Jesus Christ Temple Ministry. Watch on web, mobile, and Smart TV.";
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        />

        <title>Temple TV — Live Worship, Sermons & Teachings</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="keywords" content="Temple TV, JCTM, Jesus Christ Temple Ministry, live worship, sermons, online church, Christian teachings, Nigeria church, gospel streaming" />
        <meta name="author" content="Jesus Christ Temple Ministry" />
        <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <link rel="canonical" href={SITE_URL} />
        <link rel="alternate" hrefLang="en" href={SITE_URL} />
        <link rel="alternate" hrefLang="x-default" href={SITE_URL} />

        {/*
         * Preconnect / DNS-prefetch to YouTube edge domains. Saves 100-300ms
         * on the first sermon load by overlapping TLS + DNS with our JS bundle.
         * Includes the cookieless youtube-nocookie host the player prefers.
         */}
        <link rel="preconnect" href="https://www.youtube-nocookie.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://www.youtube.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://i.ytimg.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://s.ytimg.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://yt3.ggpht.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://www.youtube-nocookie.com" />
        <link rel="dns-prefetch" href="https://i.ytimg.com" />
        <link rel="dns-prefetch" href="https://googlevideo.com" />

        <meta name="theme-color" content="#6A0DAD" />
        <meta name="application-name" content="Temple TV" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Temple TV" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="format-detection" content="telephone=no" />

        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Temple TV" />
        <meta property="og:title" content="Temple TV — Live Worship, Sermons & Teachings" />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Temple TV — Live Worship & Sermons" />
        <meta property="og:locale" content="en_US" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Temple TV — Live Worship, Sermons & Teachings" />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE} />

        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />

        <link rel="preconnect" href="https://api.templetv.org.ng" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://www.youtube.com" />
        <link rel="preconnect" href="https://i.ytimg.com" />
        <link rel="dns-prefetch" href="https://img.youtube.com" />

        {/*
          Single @graph payload combining Organization, WebSite (with sitelinks
          SearchAction), and the always-on BroadcastService. Google prefers a
          consolidated graph over multiple disconnected JSON-LD blocks.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": `${SITE_URL}/#organization`,
                  name: "Jesus Christ Temple Ministry",
                  alternateName: "Temple TV",
                  url: SITE_URL,
                  logo: {
                    "@type": "ImageObject",
                    url: `${SITE_URL}/icon-512.png`,
                    width: 512,
                    height: 512,
                  },
                  sameAs: [
                    "https://www.youtube.com/channel/UCPFFvkE-KGpR37qJgvYriJg",
                  ],
                  description: DESCRIPTION,
                },
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  url: SITE_URL,
                  name: "Temple TV",
                  description: DESCRIPTION,
                  publisher: { "@id": `${SITE_URL}/#organization` },
                  inLanguage: "en",
                  potentialAction: {
                    "@type": "SearchAction",
                    target: {
                      "@type": "EntryPoint",
                      urlTemplate: `${SITE_URL}/library?q={search_term_string}`,
                    },
                    "query-input": "required name=search_term_string",
                  },
                },
                {
                  "@type": "BroadcastService",
                  "@id": `${SITE_URL}/#broadcast`,
                  name: "Temple TV Live",
                  broadcaster: { "@id": `${SITE_URL}/#organization` },
                  broadcastDisplayName: "Temple TV",
                  inLanguage: "en",
                  videoFormat: "HD",
                  url: SITE_URL,
                },
                {
                  "@type": "MobileApplication",
                  name: "Temple TV",
                  operatingSystem: "iOS, Android, Web",
                  applicationCategory: "LifestyleApplication",
                  offers: {
                    "@type": "Offer",
                    price: "0",
                    priceCurrency: "USD",
                  },
                },
              ],
            }),
          }}
        />

        <ScrollViewStyleReset />

        {/*
          Replit dev proxy: the mobile web preview is mounted at /mobile/ by the
          API server proxy. Expo Router's stripBaseUrl() reads
          process.env.EXPO_BASE_URL, which babel-preset-expo inlines at bundle
          time from the Metro transform caller's `baseUrl` field. In Replit's
          dev environment that inlining may yield an empty string, so we also
          rewrite window.location synchronously here (before the deferred bundle
          script) as a belt-and-suspenders fix.  Once URL is rewritten to /,
          Expo Router sees the index route and all in-app navigation works.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var b='/mobile';var p=location.pathname;if(p===b||p.startsWith(b+'/')){var np=p.slice(b.length)||'/';history.replaceState(null,'',np+location.search+location.hash);}}catch(e){}})();`,
          }}
        />

        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body, #root { height: 100%; margin: 0; padding: 0; }
              body { background-color: #F8F5FF; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
              #root { display: flex; flex: 1; }
              #boot-splash { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; background: linear-gradient(180deg, #F8F5FF 0%, #EDE3FF 100%); z-index: 9999; transition: opacity 0.4s ease; }
              #boot-splash img { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 10px 30px rgba(106, 13, 173, 0.25); animation: pulse 1.6s ease-in-out infinite; }
              #boot-splash .label { margin-top: 18px; font-size: 18px; font-weight: 600; color: #6A0DAD; letter-spacing: 0.2px; }
              #boot-splash .sub { margin-top: 6px; font-size: 13px; color: #8b5cb8; }
              @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.96); opacity: 0.85; } }
              #root:not(:empty) ~ #boot-splash { opacity: 0; pointer-events: none; }
            `,
          }}
        />
      </head>
      <body>
        <noscript>
          <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
            <h1>Temple TV requires JavaScript</h1>
            <p>Please enable JavaScript in your browser to watch live worship and sermons.</p>
          </div>
        </noscript>
        {children}
        <div id="boot-splash" aria-hidden="true">
          <img src="/icon.png" alt="" />
          <div className="label">Temple TV</div>
          <div className="sub">Loading…</div>
        </div>
      </body>
    </html>
  );
}
