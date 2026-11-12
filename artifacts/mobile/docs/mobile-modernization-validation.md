# Temple TV modernization — implementation and validation

## Release preparation

- App version: **1.0.77**, Android version code **147**.
- Existing Expo/RN generation, production endpoints, account logic, broadcast
  engine, offline-download machinery and player state machines retained.
- No Expo cloud build, Play Store submission, production deployment or GitHub
  push was performed for this upgrade.

## Implemented

- Shared Temple TV palettes, clearer text contrast and consistent card surfaces.
- Broadcast-first home with quick access to Channels, Radio, Library, Search,
  Favorites and Give.
- Dedicated Daily Devotion banner using the same real daily API as the official
  JCTM devotion page. It displays actual title, excerpt, date and an image only
  when the publisher supplies one.
- Exact **Read Full Devotion** action opens the official reading page through
  the browser, with explicit retry/fallback on opening errors.
- Persistent public-content cache survives network/source failures and app
  restarts. Requests are coalesced, bounded and timed out; refresh runs every
  five minutes only while Home is focused and the app is active.
- No invented devotion, date, image, article link or sample content in runtime.
- Accessibility/contrast/touch-control improvements across twenty supporting
  routes; see `mobile-ui-modernization-audit.md` for scope.
- Separate playback/share/options/recent-search controls prevent nested-button
  errors and accidental parent actions. Hidden connection banners are removed
  from the accessibility tree.
- Theme consumers stop creating fallback clock timers after ThemeProvider is
  ready. Shared reduced-motion handling uses one native subscription for all
  cards/buttons and ignores late replies after unmount.
- Browser preview has a fixed same-origin devotion relay and REST API relay.
  Native devotion retrieval remains independent of the Temple TV API.

## Verified

- TypeScript check passed.
- Standard mobile test command passed: **262 tests, zero failures**. It includes
  startup, navigation, playback-hook contracts, viewer tracking, offline
  recording/download models, devotion caching/failures/concurrency and shared
  reduced-motion lifecycle checks.
- Syntax-tree guards cover both card layouts, Search and Home against nested
  interactive controls.
- Final Android and iOS production **JavaScript/Hermes exports passed**. These
  are not native APK/AAB builds or installed-device tests.
- Official daily API and local relay returned real matching data; the source
  supplied “Test the Spirits”, dated 2026-11-12, during verification.
- Browser test opened the exact official devotion page, which loaded the
  matching full devotion. Blocking the devotion relay and reloading app assets
  online retained the saved devotion without fabricated replacement content.
- Browser journey covered Home, Channels, Library, Search, Radio, history,
  favorites, Watch Later, downloads, playlists, series shortcut, settings,
  login/signup/forgot-password, Contact, Donate and feedback-dialog rendering.
  Empty login/signup validation was exercised without creating accounts.
- Home fit 320, 402 and 800-pixel viewports without horizontal overflow.
- Follow-up confirmed card-to-player dispatch, separate Search Play/Share
  controls, empty search results for an unmatched query, a distinctive matching
  result and normal bottom-tab navigation after the card fixes.
- A further nested Recent Searches row found during that follow-up was fixed
  and checked with compilation and the new nesting guards; no third broad
  browser pass was run.

## Remaining release gates — do not label production-certified yet

1. **Installed Android acceptance:** real phones/tablets, system font scaling,
   TalkBack, low-memory/background/reconnection behavior and actual performance
   measurements have not been verified. No Android device/ADB/KVM was available
   in this workspace.
2. **Playback and offline files:** confirm real media time advances, PiP,
   background transitions and genuine local recorded-video playback in airplane
   mode. Unit/model tests and exports cannot certify these native behaviors.
3. **Signed-in account paths:** no production credentials/accounts were used;
   authenticated settings, password/MFA and linked-device behavior remain
   unverified end-to-end.
4. **Browser preview realtime/media transport:** Metro preview WebSocket routes
   `/api/playback/ws`, `/api/broadcast-v2/ws` and `/api/chat/ws` failed in the
   browser. REST forwarding does not implement WebSocket upgrades. Browser
   playback/chat therefore remain unverified. Workflow logs also report
   `NotSupportedError` for selected media sources and interrupted play requests.
   These errors are not suppressed or treated as successful playback; installed
   Android behavior still needs separate verification.

The radio screen correctly reported that no stream was configured. No radio
URL, backend data or production configuration was substituted to conceal this.
External connectivity probes also generated browser CORS warnings. The hidden
banner's accessibility announcement was corrected without changing native
connectivity policy.
