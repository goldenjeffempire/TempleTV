import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("mobile and TV chat ticket transport", () => {
  for (const file of [
    "../../../mobile/lib/chat/ChatClient.ts",
    "../../../tv/src/chat/ChatClient.ts",
  ]) {
    it(`${file} never places bearer tokens in the websocket URL`, () => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /ticket/);
      assert.doesNotMatch(source, /params\.(?:push|set)\(["']token["']/);
      assert.match(source, /Authorization:\s*`Bearer \$\{this\.opts\.token\}`/);
      assert.match(source, /new WebSocket\(url\)/);
    });
  }
});
