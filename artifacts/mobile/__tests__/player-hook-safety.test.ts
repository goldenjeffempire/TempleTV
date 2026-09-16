/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const miniPlayerSource = readFileSync(
  new URL("../components/MiniPlayer.tsx", import.meta.url),
  "utf8",
);
const playerSource = readFileSync(
  new URL("../app/player.tsx", import.meta.url),
  "utf8",
);

describe("player hook safety", () => {
  it("runs every MiniPlayer hook before the visibility return", () => {
    const cleanupEffect = miniPlayerSource.indexOf(
      "useEffect(() => () => {\n    if (navigatingTimerRef.current)",
    );
    const visibilityReturn = miniPlayerSource.indexOf(
      "if (!shouldRender) return null;",
    );

    assert.ok(cleanupEffect >= 0, "navigation cleanup effect is missing");
    assert.ok(visibilityReturn > cleanupEffect);
  });

  it("owns and asynchronously releases its wake-lock tag", () => {
    assert.match(
      playerSource,
      /const PLAYER_KEEP_AWAKE_TAG = "templetv-player"/,
    );
    assert.match(
      playerSource,
      /activateKeepAwakeAsync\(PLAYER_KEEP_AWAKE_TAG\)/,
    );
    assert.match(
      playerSource,
      /deactivateKeepAwake\(PLAYER_KEEP_AWAKE_TAG\)\.catch/,
    );
    assert.doesNotMatch(playerSource, /deactivateKeepAwake\(\);/);
  });
});