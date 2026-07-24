/**
 * adManager.ts — Google IMA HTML5 SDK wrapper for Temple TV Smart TV.
 *
 * Design goals:
 *   • VMAP-first: a single VMAP request to Google Ad Manager schedules
 *     prerolls, midrolls, and postrolls server-side. No client-side timers
 *     or ad scheduling logic required.
 *   • Non-disruptive: uses mute/unmute instead of pause/resume on the live
 *     HLS buffers so the broadcast FSM is never disturbed during an ad break.
 *     The ad video plays with audio; the underlying stream continues muted
 *     behind the ad container until the break ends.
 *   • Graceful degradation: if google.ima is unavailable (script blocked by
 *     an ad blocker, old Smart TV runtime that blocks the CDN, or network
 *     failure fetching the SDK), every method is a silent no-op and the
 *     broadcast plays without ads.
 *   • Frequency cap: a 30-minute localStorage-backed session cap prevents
 *     spurious re-requests when the component remounts within the same
 *     viewing session.
 *   • CTV-safe: VPAID is disabled (CTV environments don't run VPAID); the
 *     player is identified to GAM as a Smart TV surface.
 */

const AD_SESSION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const LS_KEY = "_ttv_last_ad_ts";

/** True when the IMA SDK has been loaded and is accessible. */
function isImaAvailable(): boolean {
  try {
    return (
      typeof (globalThis as Record<string, unknown>).google !== "undefined" &&
      typeof (globalThis as { google: { ima?: unknown } }).google.ima !== "undefined"
    );
  } catch {
    return false;
  }
}

/** True when enough time has passed since the last ad session. */
function isSessionEligible(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return true;
    return Date.now() - Number(raw) >= AD_SESSION_COOLDOWN_MS;
  } catch {
    return true;
  }
}

function stampSessionTime(): void {
  try {
    localStorage.setItem(LS_KEY, String(Date.now()));
  } catch {
    /* private browsing / storage full — ignore */
  }
}

export interface AdManagerCallbacks {
  /** Mute live video buffers — called when a linear ad is about to play. */
  onContentPauseRequested(): void;
  /** Restore live video buffers — called when the ad break ends. */
  onContentResumeRequested(): void;
  /** Ad error — broadcast should not be interrupted. */
  onAdError(code: number, message: string): void;
  /** First ad in the session has started. */
  onAdStarted?(): void;
  /** All ads in the schedule have completed. */
  onAllAdsCompleted?(): void;
}

export class AdManager {
  private readonly adTagUrl: string;
  private readonly adContainer: HTMLElement;
  private readonly videoElement: HTMLVideoElement | null;
  private readonly callbacks: AdManagerCallbacks;

  private adDisplayContainer: google.ima.AdDisplayContainer | null = null;
  private adsLoader: google.ima.AdsLoader | null = null;
  private adsManager: google.ima.AdsManager | null = null;
  private destroyed = false;

  constructor(opts: {
    adTagUrl: string;
    adContainer: HTMLElement;
    videoElement: HTMLVideoElement | null;
    callbacks: AdManagerCallbacks;
  }) {
    this.adTagUrl = opts.adTagUrl;
    this.adContainer = opts.adContainer;
    this.videoElement = opts.videoElement;
    this.callbacks = opts.callbacks;
  }

  /**
   * Initialize the IMA SDK internals. Safe to call immediately at mount — it
   * does NOT require a user gesture. The AdDisplayContainer.initialize() call
   * (which does need a gesture on some platforms) is deferred to requestAds().
   */
  init(): void {
    if (!isImaAvailable() || this.destroyed) return;

    try {
      // CTV configuration — disable VPAID, identify surface.
      google.ima.settings.setVpaidMode(google.ima.VpaidMode.DISABLED);
      google.ima.settings.setLocale("en");
      google.ima.settings.setPlayerType("com.templetv.tv");
      google.ima.settings.setPlayerVersion("1.0.0");
      // Smart TVs start video automatically and without muting, so IMA can
      // play audio immediately without an explicit unmute gesture.
      google.ima.settings.setAutoPlayAdBreaks(true);

      this.adDisplayContainer = new google.ima.AdDisplayContainer(
        this.adContainer,
        this.videoElement ?? undefined,
      );

      this.adsLoader = new google.ima.AdsLoader(this.adDisplayContainer);

      this.adsLoader.addEventListener(
        google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED,
        this.handleAdsManagerLoaded,
      );
      this.adsLoader.addEventListener(
        google.ima.AdErrorEvent.Type.AD_ERROR,
        this.handleAdError,
      );
    } catch (err) {
      console.warn("[AdManager] init failed", err);
    }
  }

  /**
   * Request ads from GAM. On CTV surfaces the IMA SDK allows this to be called
   * without a preceding user gesture, but initialize() is still required first.
   * Returns false if the session frequency cap blocks the request.
   */
  requestAds(): boolean {
    if (!isImaAvailable() || this.destroyed) return false;
    if (!this.adsLoader || !this.adDisplayContainer) return false;
    if (!isSessionEligible()) return false;

    try {
      // initialize() bootstraps the ad container DOM — must be called before
      // requestAds(). On CTV this is safe to call outside a user gesture.
      this.adDisplayContainer.initialize();

      const req = new google.ima.AdsRequest();
      req.adTagUrl = this.adTagUrl;
      // Slot dimensions — use container size, fall back to 1080p.
      req.linearAdSlotWidth = this.adContainer.offsetWidth || 1920;
      req.linearAdSlotHeight = this.adContainer.offsetHeight || 1080;
      req.nonLinearAdSlotWidth = this.adContainer.offsetWidth || 1920;
      req.nonLinearAdSlotHeight = this.adContainer.offsetHeight || 1080;
      // Live broadcast plays automatically and is not muted.
      req.setAdWillAutoPlay(true);
      req.setAdWillPlayMuted(false);
      // VAST load timeout (ms) — more generous than default 5 000 ms for
      // Smart TV networks where round-trip latency can be higher.
      req.vastLoadTimeout = 10_000;

      this.adsLoader.requestAds(req);
      stampSessionTime();
      return true;
    } catch (err) {
      console.warn("[AdManager] requestAds failed", err);
      return false;
    }
  }

  /** Notify IMA that live content has been replaced (e.g., stream restart).
   *  Triggers any scheduled postroll if the VMAP contains one. */
  contentComplete(): void {
    if (!isImaAvailable() || this.destroyed) return;
    try {
      this.adsLoader?.contentComplete();
    } catch {
      /* ignore */
    }
  }

  /** Call on window/container resize to keep ad rendering pixel-perfect. */
  resize(width: number, height: number): void {
    if (!isImaAvailable() || this.destroyed) return;
    try {
      this.adsManager?.resize(
        width,
        height,
        document.fullscreenElement
          ? google.ima.ViewMode.FULLSCREEN
          : google.ima.ViewMode.NORMAL,
      );
    } catch {
      /* ignore */
    }
  }

  /** Pause a running ad (e.g., user navigated away). */
  pause(): void {
    if (!isImaAvailable() || this.destroyed) return;
    try { this.adsManager?.pause(); } catch { /* ignore */ }
  }

  /** Resume a paused ad. */
  resume(): void {
    if (!isImaAvailable() || this.destroyed) return;
    try { this.adsManager?.resume(); } catch { /* ignore */ }
  }

  /** Tear down all IMA SDK resources. Call on component unmount. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.adsManager?.destroy();
      this.adsLoader?.destroy();
      this.adDisplayContainer?.destroy();
    } catch {
      /* ignore */
    }
    this.adsManager = null;
    this.adsLoader = null;
    this.adDisplayContainer = null;
  }

  // ── Private handlers ────────────────────────────────────────────────────────

  private readonly handleAdsManagerLoaded = (
    event: google.ima.AdsManagerLoadedEvent,
  ): void => {
    if (this.destroyed) return;
    try {
      const settings = new google.ima.AdsRenderingSettings();
      settings.enablePreloading = true;
      settings.useStyledLinearAds = false;
      settings.useStyledNonLinearAds = false;
      // Generous load timeout for Smart TV networks.
      settings.loadVideoTimeout = 10_000;

      this.adsManager = event.getAdsManager(
        this.videoElement ?? undefined,
        settings,
      );

      // Wire ad lifecycle events.
      this.adsManager.addEventListener(
        google.ima.AdEvent.Type.CONTENT_PAUSE_REQUESTED,
        this.handleContentPauseRequested,
      );
      this.adsManager.addEventListener(
        google.ima.AdEvent.Type.CONTENT_RESUME_REQUESTED,
        this.handleContentResumeRequested,
      );
      this.adsManager.addEventListener(
        google.ima.AdErrorEvent.Type.AD_ERROR,
        this.handleAdError,
      );
      this.adsManager.addEventListener(
        google.ima.AdEvent.Type.ALL_ADS_COMPLETED,
        this.handleAllAdsCompleted,
      );
      this.adsManager.addEventListener(
        google.ima.AdEvent.Type.STARTED,
        this.handleAdStarted,
      );

      // Init at the container's current dimensions.
      const w = this.adContainer.offsetWidth || 1920;
      const h = this.adContainer.offsetHeight || 1080;
      this.adsManager.init(w, h, google.ima.ViewMode.NORMAL);
      this.adsManager.start();
    } catch (err) {
      console.warn("[AdManager] adsManagerLoaded handler failed", err);
      // Resume content immediately if IMA init throws.
      this.callbacks.onContentResumeRequested();
    }
  };

  private readonly handleContentPauseRequested = (): void => {
    if (this.destroyed) return;
    try {
      this.callbacks.onContentPauseRequested();
    } catch {
      /* ignore */
    }
  };

  private readonly handleContentResumeRequested = (): void => {
    if (this.destroyed) return;
    try {
      this.callbacks.onContentResumeRequested();
    } catch {
      /* ignore */
    }
  };

  private readonly handleAdError = (event: google.ima.AdErrorEvent): void => {
    if (this.destroyed) return;
    const err = (event as google.ima.AdErrorEvent).getError?.();
    const code = err?.getErrorCode?.() ?? -1;
    const msg = err?.getMessage?.() ?? "Unknown ad error";
    console.warn(`[AdManager] ad error ${code}: ${msg}`);
    this.callbacks.onAdError(code, msg);
    // Always resume content on error so the broadcast is never silently muted.
    try { this.callbacks.onContentResumeRequested(); } catch { /* ignore */ }
    // Destroy the broken manager so we don't retry from a bad state.
    try { this.adsManager?.destroy(); } catch { /* ignore */ }
    this.adsManager = null;
  };

  private readonly handleAllAdsCompleted = (): void => {
    if (this.destroyed) return;
    try { this.callbacks.onAllAdsCompleted?.(); } catch { /* ignore */ }
  };

  private readonly handleAdStarted = (): void => {
    if (this.destroyed) return;
    try { this.callbacks.onAdStarted?.(); } catch { /* ignore */ }
  };
}
