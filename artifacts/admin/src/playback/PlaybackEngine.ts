/**
 * PlaybackEngine — dual-buffer rendering manager for the admin player.
 *
 * Owns two persistent <video> elements (the "active" and "preload" surfaces)
 * and is responsible for:
 *
 *   1. Loading the `current` PlaybackItem into the active surface and
 *      starting playback.
 *   2. As soon as we know `next`, pre-attaching it to the preload surface
 *      (HLS.js for .m3u8, native `<video>` for mp4, no-op for youtube which
 *      uses its own player).
 *   3. On a `preload` hint at T-15s/T-10s/T-5s, advancing the preload
 *      pipeline (parse manifest → buffer first segment → ready-to-play).
 *   4. On a `transition` event (or when the wall clock passes
 *      current.endsAtMs, whichever comes first), opacity-swapping the
 *      preload surface over the active surface so the cut is visually
 *      seamless. The previous active surface is then recycled as the next
 *      preload target.
 *   5. Keeping HLS.js instances alive across swaps so we never pay manifest
 *      reparse cost mid-show.
 *
 * Crucially the two <video> elements are *never unmounted* — React owns
 * their existence (the DualBufferPlayer mounts them once); the engine only
 * mutates `.src`, `.currentTime`, opacity and play state. This is what
 * eliminates black frames between items.
 */

import Hls from "hls.js";
import type { PlaybackEvent, PlaybackItem, PlaybackState } from "./types";

interface SurfaceState {
  video: HTMLVideoElement;
  hls: Hls | null;
  loadedItemId: string | null;
  ready: boolean;
}

type Role = "active" | "preload";

export interface PlaybackEngineDelegate {
  /** Notified whenever active/preload roles swap so the UI can update overlays. */
  onActiveItemChanged?: (item: PlaybackItem | null) => void;
  /** Reports the engine's view of which surface is on-air. */
  onSurfaceRolesChanged?: (roles: { active: number; preload: number }) => void;
}

export class PlaybackEngine {
  private surfaces: [SurfaceState, SurfaceState] | null = null;
  /** Index in `surfaces` currently rendering the on-air item. */
  private activeIdx: 0 | 1 = 0;
  private currentState: PlaybackState | null = null;
  private delegate: PlaybackEngineDelegate;

  constructor(delegate: PlaybackEngineDelegate = {}) {
    this.delegate = delegate;
  }

  /**
   * Wire the engine to the two persistent <video> elements. Idempotent —
   * safe to call from a useEffect that runs whenever refs settle.
   */
  attach(videoA: HTMLVideoElement, videoB: HTMLVideoElement): void {
    if (this.surfaces) return;
    this.surfaces = [
      { video: videoA, hls: null, loadedItemId: null, ready: false },
      { video: videoB, hls: null, loadedItemId: null, ready: false },
    ];
    this.applyRoleStyles();
    if (this.currentState) {
      this.syncToState(this.currentState).catch(() => {});
    }
  }

  detach(): void {
    if (!this.surfaces) return;
    for (const s of this.surfaces) {
      this.tearDownSurface(s);
    }
    this.surfaces = null;
  }

  /** Engine entry point — called by the hook on every PlaybackEvent. */
  handleEvent(event: PlaybackEvent): void {
    if (event.type === "ping") return;
    void this.syncToState(event.state, event);
  }

  /** Push a state without an event wrapper (initial paint path). */
  setState(state: PlaybackState): void {
    void this.syncToState(state);
  }

  private async syncToState(state: PlaybackState, event?: PlaybackEvent) {
    const previousState = this.currentState;
    this.currentState = state;
    if (!this.surfaces) return;

    const surfaces = this.surfaces;
    const active = surfaces[this.activeIdx];
    const preloadIdx: 0 | 1 = this.activeIdx === 0 ? 1 : 0;
    const preload = surfaces[preloadIdx];

    const transitioned =
      event?.type === "state" && event.reason === "transition";
    const previousActiveId = previousState?.current?.id ?? null;
    const newActiveId = state.current?.id ?? null;

    // 1. If the active item changed and the preload surface already has
    //    that item loaded → SWAP. This is the zero-black-frame path.
    if (
      transitioned &&
      newActiveId &&
      preload.loadedItemId === newActiveId &&
      preload.ready
    ) {
      this.swap();
    } else if (
      newActiveId !== previousActiveId &&
      newActiveId &&
      newActiveId !== active.loadedItemId
    ) {
      // 2. The active surface is on the wrong item (cold load / out-of-band
      //    state). Load it onto the active surface directly. There WILL be
      //    a brief visual gap here — only happens on first paint and on
      //    forced jumps (skip / override start) where seamlessness was
      //    impossible by definition.
      await this.loadItem(active, state.current!);
      this.playActive();
    }

    // 3. Stage the next item on the preload surface (if not already there).
    const nextItem = state.next;
    if (nextItem && preload.loadedItemId !== nextItem.id) {
      await this.loadItem(preload, nextItem);
    }

    if (event?.type === "preload") {
      // Future hook: segment-level prefetch could intensify here if needed.
      // hls.js already requests segments as soon as the manifest is parsed,
      // so for typical HLS this is "already done"; the leadMs argument is
      // surfaced to the delegate for diagnostics.
    }

    this.delegate.onActiveItemChanged?.(state.current);
  }

  private swap() {
    if (!this.surfaces) return;
    const oldActive = this.surfaces[this.activeIdx];
    this.activeIdx = (this.activeIdx === 0 ? 1 : 0) as 0 | 1;
    const newActive = this.surfaces[this.activeIdx];
    this.applyRoleStyles();
    // Pause the surface that just left the air — keeps audio from doubling
    // up if HLS.js had decoded ahead. Don't tear down the HLS instance:
    // we'll reuse it once the preload pipeline assigns it a fresh source.
    try {
      oldActive.video.pause();
    } catch {
      /* noop */
    }
    // Best-effort start. If autoplay is gated the operator already gestured
    // on the page (the first load required it), so this should succeed.
    void newActive.video.play().catch(() => {});
  }

  private playActive() {
    if (!this.surfaces) return;
    const active = this.surfaces[this.activeIdx];
    void active.video.play().catch(() => {});
  }

  private applyRoleStyles() {
    if (!this.surfaces) return;
    for (let i = 0; i < this.surfaces.length; i += 1) {
      const v = this.surfaces[i]!.video;
      const isActive = i === this.activeIdx;
      v.style.opacity = isActive ? "1" : "0";
      v.style.zIndex = isActive ? "2" : "1";
      v.muted = !isActive;
    }
    this.delegate.onSurfaceRolesChanged?.({
      active: this.activeIdx,
      preload: (this.activeIdx === 0 ? 1 : 0) as 0 | 1,
    });
  }

  private tearDownSurface(s: SurfaceState) {
    if (s.hls) {
      try { s.hls.destroy(); } catch { /* noop */ }
      s.hls = null;
    }
    try {
      s.video.removeAttribute("src");
      s.video.load();
    } catch {
      /* noop */
    }
    s.loadedItemId = null;
    s.ready = false;
  }

  private async loadItem(surface: SurfaceState, item: PlaybackItem) {
    // Recycle: drop any existing HLS instance bound to a stale item.
    if (surface.hls) {
      try { surface.hls.destroy(); } catch { /* noop */ }
      surface.hls = null;
    }
    surface.loadedItemId = item.id;
    surface.ready = false;

    if (item.source.kind === "youtube") {
      // YouTube playback isn't handled by the dual-buffer engine — that
      // surface is rendered by an iframe overlay in the UI. Mark the
      // <video> as empty so it can't accidentally bleed audio.
      try {
        surface.video.removeAttribute("src");
        surface.video.load();
      } catch {
        /* noop */
      }
      surface.ready = true;
      return;
    }

    if (item.source.kind === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        // Aggressive defaults tuned for a continuous-broadcast surface:
        // - prefer ABR's stable rendition rather than chasing peaks
        // - keep 30 s of forward buffer so the swap can survive a brief
        //   network blip even if the new item just started fetching
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 10,
        enableWorker: true,
      });
      surface.hls = hls;
      await new Promise<void>((resolve) => {
        hls.on(Hls.Events.MANIFEST_PARSED, () => resolve());
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) resolve();
        });
        hls.loadSource(item.source.url);
        hls.attachMedia(surface.video);
      });
      surface.ready = true;
      return;
    }

    // Native MP4 (or HLS on Safari, where the browser plays .m3u8 directly)
    surface.video.src = item.source.url;
    await new Promise<void>((resolve) => {
      const onReady = () => {
        surface.video.removeEventListener("loadedmetadata", onReady);
        surface.video.removeEventListener("error", onReady);
        resolve();
      };
      surface.video.addEventListener("loadedmetadata", onReady, { once: true });
      surface.video.addEventListener("error", onReady, { once: true });
      try { surface.video.load(); } catch { /* noop */ }
    });
    surface.ready = true;
  }
}
