import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { offlineRecordingKey } from "../../src/modules/videos/offline-recording-policy.js";
const video = { videoSource: "local", localVideoUrl: "/api/v1/uploads/a/b.mp4",
  objectPath: "uploads/a/b.mp4", checksumSha256: "a".repeat(64),
  validationStatus: "passed", transcodingErrorCode: null };

describe("offline recording authorization boundary", () => {
  it("accepts a checksummed first-party recording", () => assert.equal(offlineRecordingKey(video), video.objectPath));
  it("rejects providers and manifests", () => {
    assert.equal(offlineRecordingKey({ ...video, videoSource: "youtube" }), null);
    assert.equal(offlineRecordingKey({ ...video, objectPath: "uploads/a/index.m3u8" }), null);
  });
  it("rejects arbitrary URLs, traversal and malformed integrity metadata", () => {
    for (const objectPath of ["https://evil.test/movie.mp4", "uploads/../private.mp4", "/uploads/b.mp4"]) {
      assert.equal(offlineRecordingKey({ ...video, objectPath }), null);
    }
    assert.equal(offlineRecordingKey({ ...video, checksumSha256: "not-a-checksum" }), null);
    assert.equal(offlineRecordingKey({ ...video, checksumSha256: null }), video.objectPath);
  });
  it("denies terminal or failed assets", () => {
    assert.equal(offlineRecordingKey({ ...video, validationStatus: "failed" }), null);
    for (const transcodingErrorCode of ["CORRUPT_SOURCE", "SOURCE_MISSING", "ASSEMBLY_FAILED", "STORAGE_LOST"]) {
      assert.equal(offlineRecordingKey({ ...video, transcodingErrorCode }), null);
    }
  });
});
