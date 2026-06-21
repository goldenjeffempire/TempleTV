/**
 * React Native / Expo adapter contract.
 *
 * Unlike the web adapter (which can directly manipulate <video> elements),
 * the mobile adapter is purely a state contract. Each buffer is a React
 * component (`<VideoView>` from expo-video) that subscribes to the
 * `MobileBufferState` exposed via the adapter and renders accordingly.
 *
 * The PlayerContainer mounts both buffers permanently and never unmounts them.
 */

import type { AdapterIntent, IntentHandler } from "../machine.js";
import type { PlayerEvent, V2Item, V2Override } from "../types.js";

export interface MobileBufferState {
  /** Currently bound source. */
  item: V2Item | V2Override | null;
  /** Should the buffer play right now? */
  playing: boolean;
  /** Should the buffer be visible (active) or hidden behind the other (inactive)? */
  active: boolean;
  /** Resume position when binding/playing. */
  positionSecs: number;
  /** Mute non-active buffer to prevent audio overlap. */
  muted: boolean;
  /**
   * Incremented on every `bind` intent, even when the URL is unchanged
   * (e.g. RECOVERING_PRIMARY rebinds the same source). Buffer components
   * track this revision instead of the URL string so that recovery rebinds
   * always trigger a fresh `buffer-ready` report to the FSM — without this,
   * the `lastReportedReady` URL-equality guard would silently swallow the
   * `onLoad` event for same-URL recoveries, leaving the FSM stuck.
   */
  bindRevision: number;
}

export interface MobileAdapterStore {
  A: MobileBufferState;
  B: MobileBufferState;
  /** Bumped on every change so React effects re-run. */
  revision: number;
}

export interface MobileAdapter {
  /** Apply an intent into the store (returns new store). */
  apply: IntentHandler;
  /** Subscribe to store changes. */
  subscribe: (fn: (store: MobileAdapterStore) => void) => () => void;
  /** Read current store. */
  getStore: () => MobileAdapterStore;
  /** Buffer-* event injector — called by the buffer component on mount/unmount/error/ended/stall. */
  reportEvent: (event: PlayerEvent) => void;
}

const initialBuffer: MobileBufferState = {
  item: null,
  playing: false,
  active: false,
  positionSecs: 0,
  muted: true,
  bindRevision: 0,
};

export function createMobileAdapter(send: (event: PlayerEvent) => void): MobileAdapter {
  let store: MobileAdapterStore = {
    A: { ...initialBuffer, active: true, muted: false },
    B: { ...initialBuffer },
    revision: 0,
  };
  const listeners = new Set<(s: MobileAdapterStore) => void>();

  const update = (mut: (s: MobileAdapterStore) => void): void => {
    const next: MobileAdapterStore = {
      A: { ...store.A },
      B: { ...store.B },
      revision: store.revision + 1,
    };
    mut(next);
    store = next;
    for (const l of listeners) l(store);
  };

  const apply: IntentHandler = (intent: AdapterIntent) => {
    switch (intent.type) {
      case "bind":
        return update((s) => {
          s[intent.bufferId].item = intent.item;
          s[intent.bufferId].positionSecs = 0;
          // Always bump the revision — even for the same URL — so that
          // RECOVERING_PRIMARY rebinds (same source, new attempt) cause
          // the buffer component to reset its lastReportedRevision guard
          // and fire a fresh buffer-ready when onLoad fires.
          s[intent.bufferId].bindRevision += 1;
        });
      case "play":
        return update((s) => {
          s[intent.bufferId].playing = true;
          s[intent.bufferId].positionSecs = intent.positionSecs;
        });
      case "pause":
        return update((s) => {
          s[intent.bufferId].playing = false;
        });
      case "swap":
        return update((s) => {
          s.A.active = intent.activeBufferId === "A";
          s.B.active = intent.activeBufferId === "B";
          s.A.muted = !s.A.active;
          s.B.muted = !s.B.active;
        });
      case "unbind":
        return update((s) => {
          s[intent.bufferId].item = null;
          s[intent.bufferId].playing = false;
        });
      case "show-overlay":
      case "hide-overlay":
        return;
    }
  };

  return {
    apply,
    subscribe: (fn) => {
      listeners.add(fn);
      fn(store);
      return () => listeners.delete(fn);
    },
    getStore: () => store,
    reportEvent: (event) => send(event),
  };
}
