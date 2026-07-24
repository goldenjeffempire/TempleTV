/**
 * Minimal type declarations for the Google IMA HTML5 SDK (ima3.js).
 * The SDK is loaded from Google's CDN via a <script> tag in index.html and
 * injected into the global `google` namespace at runtime. These declarations
 * cover the subset of the API used by adManager.ts — add surface area here
 * as new IMA features are needed.
 *
 * The official full typings are in @types/google.ima on npm, but including
 * them as a devDependency pulls in the entire declaration set and can clash
 * with the ambient `google` namespace that may be declared by other packages
 * (e.g. @types/google.maps). This minimal local file is safer.
 */

declare namespace google {
  namespace ima {
    // ── Settings ─────────────────────────────────────────────────────────────
    namespace settings {
      function setVpaidMode(mode: VpaidMode): void;
      function setLocale(locale: string): void;
      function setPlayerType(type: string): void;
      function setPlayerVersion(version: string): void;
      function setDisableCustomPlaybackForIOS10Plus(disable: boolean): void;
      function setAutoPlayAdBreaks(autoPlay: boolean): void;
    }

    enum VpaidMode {
      DISABLED = 0,
      ENABLED = 1,
      INSECURE = 2,
    }

    // ── ViewMode ─────────────────────────────────────────────────────────────
    enum ViewMode {
      NORMAL = "normal",
      FULLSCREEN = "fullscreen",
    }

    // ── AdDisplayContainer ───────────────────────────────────────────────────
    class AdDisplayContainer {
      constructor(
        container: HTMLElement,
        videoElement?: HTMLVideoElement,
        click?: HTMLElement,
      );
      initialize(): void;
      destroy(): void;
    }

    // ── AdsRequest ───────────────────────────────────────────────────────────
    class AdsRequest {
      adTagUrl: string;
      linearAdSlotWidth: number;
      linearAdSlotHeight: number;
      nonLinearAdSlotWidth: number;
      nonLinearAdSlotHeight: number;
      forceNonLinearFullSlot: boolean;
      vastLoadTimeout: number;
      setAdWillAutoPlay(autoPlay: boolean): void;
      setAdWillPlayMuted(muted: boolean): void;
    }

    // ── AdsLoader ────────────────────────────────────────────────────────────
    class AdsLoader {
      constructor(adDisplayContainer: AdDisplayContainer);
      addEventListener(
        type: string,
        listener: (event: AdsManagerLoadedEvent | AdErrorEvent) => void,
        useCapture?: boolean,
      ): void;
      removeEventListener(
        type: string,
        listener: (event: AdsManagerLoadedEvent | AdErrorEvent) => void,
      ): void;
      requestAds(adsRequest: AdsRequest): void;
      /** Signal that content has completed — triggers postrolls if scheduled. */
      contentComplete(): void;
      destroy(): void;
    }

    // ── AdsManagerLoadedEvent ────────────────────────────────────────────────
    interface AdsManagerLoadedEvent {
      getAdsManager(
        contentPlayback?: HTMLVideoElement,
        adsRenderingSettings?: AdsRenderingSettings,
      ): AdsManager;
    }
    namespace AdsManagerLoadedEvent {
      enum Type {
        ADS_MANAGER_LOADED = "adsManagerLoaded",
      }
    }

    // ── AdsRenderingSettings ─────────────────────────────────────────────────
    class AdsRenderingSettings {
      enablePreloading: boolean;
      useStyledLinearAds: boolean;
      useStyledNonLinearAds: boolean;
      loadVideoTimeout: number;
      /** Seconds from the end of content at which postrolls start. */
      playAdsAfterTime: number;
    }

    // ── AdErrorEvent ─────────────────────────────────────────────────────────
    interface AdErrorEvent {
      getError(): AdError;
    }
    namespace AdErrorEvent {
      enum Type {
        AD_ERROR = "adError",
      }
    }

    interface AdError {
      getErrorCode(): number;
      getMessage(): string;
      getType(): string;
    }

    // ── AdEvent ──────────────────────────────────────────────────────────────
    interface AdEvent {
      type: string;
      getAd(): Ad;
    }
    namespace AdEvent {
      enum Type {
        CONTENT_PAUSE_REQUESTED = "contentPauseRequested",
        CONTENT_RESUME_REQUESTED = "contentResumeRequested",
        ALL_ADS_COMPLETED = "allAdsCompleted",
        STARTED = "started",
        COMPLETE = "complete",
        PAUSED = "pause",
        RESUMED = "resume",
        SKIPPED = "skip",
        SKIPPABLE_STATE_CHANGED = "skippableStateChanged",
        USER_CLOSE = "userClose",
        CLICK = "click",
        AD_BREAK_READY = "adBreakReady",
        AD_CAN_PLAY = "adCanPlay",
        AD_METADATA = "ad_metadata",
        AD_PROGRESS = "adProgress",
        DURATION_CHANGE = "durationChange",
        FIRST_QUARTILE = "firstQuartile",
        IMPRESSION = "impression",
        LINEAR_CHANGED = "linearChanged",
        LOADED = "loaded",
        MIDPOINT = "midpoint",
        THIRD_QUARTILE = "thirdQuartile",
        VIDEO_CLICKED = "videoClicked",
      }
    }

    // ── Ad ───────────────────────────────────────────────────────────────────
    interface Ad {
      getAdId(): string;
      getAdSystem(): string;
      getAdPodInfo(): AdPodInfo;
      getDuration(): number;
      getMinSuggestedDuration(): number;
      getSkipTimeOffset(): number;
      isLinear(): boolean;
      isSkippable(): boolean;
    }

    interface AdPodInfo {
      getAdPosition(): number;
      getTotalAds(): number;
      getPodIndex(): number;
      getTimeOffset(): number;
    }

    // ── AdsManager ───────────────────────────────────────────────────────────
    class AdsManager {
      addEventListener(
        type: string,
        listener: (event: AdEvent | AdErrorEvent) => void,
        useCapture?: boolean,
      ): void;
      removeEventListener(
        type: string,
        listener: (event: AdEvent | AdErrorEvent) => void,
      ): void;
      init(width: number, height: number, viewMode: ViewMode): void;
      start(): void;
      pause(): void;
      resume(): void;
      skip(): void;
      stop(): void;
      resize(width: number, height: number, viewMode: ViewMode): void;
      setVolume(volume: number): void;
      getVolume(): number;
      getRemainingTime(): number;
      isCustomClickTrackingUsed(): boolean;
      isCustomPlaybackUsed(): boolean;
      destroy(): void;
    }
  }
}
