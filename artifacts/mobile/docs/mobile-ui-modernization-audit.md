# Temple TV Mobile — UI Modernization Audit

Direction: "Sanctuary Violet" — Temple TV royal purple retained as primary, paired with a candlelight-gold accent (devotional/editorial moments only), warm parchment light background, solid `surface` cards, Inter 400–700. Motion: finite native-driver springs on press, reduced-motion aware, no looping decorative timers.

## Shared changes
- `constants/colors.ts`: warmer light background, higher-contrast `mutedForeground` (light `#5E5470`, dark 66% lavender, previously 48–50% alpha — below AA on small text). New tokens in all palettes: `surface`, `gold`, `goldSoft`, `warningSurface/Foreground`, `dangerSurface/Foreground` (replace hardcoded amber/red hexes).
- `constants/design.ts`: `MIN_TOUCH` (48) and `OFFICIAL_DEVOTION_URL`.
- `components/PressableScale.tsx` (new): shared press feedback + `useReducedMotion()`.
- `components/DailyDevotionBanner.tsx` (new): consumes `useDailyDevotion()`; loading skeleton, cached content with "Saved copy" refresh chip, cold-failure state with official-site link + Try again (no invented metadata), "Read Full Devotion" via expo-web-browser with failure panel offering Retry and Open in browser (Linking). expo-image 96×96, `cachePolicy="memory-disk"`, image-error fallback hides the image.
- `components/SectionHeader.tsx`: header role, font-scale cap, slimmer rail.
- `components/VideoCard.tsx`: richer a11y label (title/preacher/duration), testIDs, press scale, larger hitSlop + button role on overflow action, disk caching, Inter weights, slightly larger type.

## Route-by-route (pass 2: every route file in app/ reviewed)
Method: for every route I listed each Pressable that had no accessibilityRole, checked hitSlop, 44/48dp sizing, font sizes of 10pt and under, low-alpha text contrast, and keyboard handling for inputs, then made targeted in-place fixes. No data flow, validation, auth, navigation or playback logic was changed.

| Route | Finding | Outcome |
|---|---|---|
| (tabs)/_layout | Tab layout + iOS 18 redirect guard | Reviewed, no change (nav-safety invariant). |
| (tabs)/index | See pass 1 | Improved: devotion banner, quick access grid, tokenised stale/error states, 48dp retry, header roles. |
| (tabs)/library | 5 Pressables without a role (filter pills, mode pills, series card, sort button, sort options); 32–36pt pills | Improved: button/menuitem roles, selected/expanded states, sort label + testID, 40–44pt minimum heights. |
| (tabs)/channels | Retry had no role/state; 9pt label | Improved: retry role, label, busy/disabled state, testID, 44pt; 9pt→10pt. Other live badges kept compact by design. |
| (tabs)/radio | All controls already had roles | Reviewed, no change (audio machinery out of scope). |
| (tabs)/settings | All controls already had roles | Reviewed, inherits contrast tokens; no change. |
| login | 5 controls without a role; 10pt labels at 35% white (fails contrast) | Improved: roles, busy/disabled states, testIDs; labels 11pt; text/icon contrast raised to 60–62%, placeholders 45%. Validation/MFA flow untouched. |
| signup | Password toggles were unlabelled icons; submit had no role | Improved: "Show/Hide password" labels, roles, busy state, testIDs, same contrast fixes. |
| forgot-password, reset-password | No roles on submit/cancel/back; low-contrast 10pt labels; unlabelled eye toggle | Improved: roles, state, labels, testIDs, 11pt labels with higher contrast. |
| change-password | 6 controls with no role; unlabelled eye toggles and close icon | Improved: roles, labels (Close, Show/Hide each field), busy state, testIDs. |
| account | Roles present, KeyboardAvoiding present | Reviewed, no change. |
| link (TV pairing) | Close/Done/Submit had no role | Improved: roles, Close label, submit labelled "Link TV", testIDs. |
| search | Roles + hitSlop + keyboard handling present | Reviewed, no change. |
| favorites, history, watch-later | Browse CTAs had no role and were under 44pt; remove button had no role | Improved: roles, 44pt CTAs, testIDs. Remove keeps its 32pt circle + 8pt hitSlop (48 effective). |
| downloads | 7 controls with no role; action icons 26pt | Improved: roles on all, 44×44 action targets, browse testID. Download machinery untouched. |
| playlists, playlists/[id] | Retry had no role or label | Improved: role, label, 44pt, testID. |
| series/[slug], notifications | Roles present | Reviewed, no change. |
| contact | Rows and the maps button had no role | Improved: roles, maps label + testID. No inputs, so no keyboard handling needed. |
| donate | Links, copy rows and email had no role/hints | Improved: link/button roles, copy hints, 44pt rows, email testID. Account data unchanged. |
| player, live, offline-player | Playback/session machinery | Reviewed, intentionally untouched (constraint). |
| +not-found | Hardcoded colours | Improved (pass 1): themed. |
| +html, _layout (root) | Web shell/providers (main agent owns) | Reviewed, no change. |

Shared: SectionHeader no longer caps font scaling (title wraps at any size). ErrorFallback, SkeletonCard and SermonCard were reviewed: roles were already present, so no change.

## Gaps (honest)
- Pass 2 changes are focused on accessibility, touch targets and contrast, not visual redesigns. Auth screens still use their own dark hardcoded palette rather than useColors() tokens; moving them to tokens would be a larger visual change I did not make.
- Several compact badges (LIVE, counts) stay at 10pt by design. Settings, radio, account and search got no structural layout pass.
- The devotion service and hook are integrated; typecheck and the devotion cache tests pass.
- Browser verification found nested playback/share buttons in the existing SermonCard horizontal layout; both card components now keep playback and secondary actions separate. A syntax-tree regression check prevents this hierarchy from returning.
- No installed-native-device testing has been performed. Browser checks cannot certify Android playback, PiP, offline files, codecs, native font scaling or release memory behavior.
