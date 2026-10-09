import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const eas = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8"));

function resolveProfile(name: string, ancestors: string[] = []): Record<string, any> {
  assert.ok(!ancestors.includes(name), `Circular profile inheritance: ${name}`);
  const current = eas.build[name];
  assert.ok(current, `Missing build profile: ${name}`);
  const parent = current.extends
    ? resolveProfile(current.extends, [...ancestors, name])
    : {};
  return {
    ...parent,
    ...current,
    android: { ...parent.android, ...current.android },
    env: { ...parent.env, ...current.env },
  };
}

describe("Android native-validation profile", () => {
  const validation = resolveProfile("android-validation");
  const production = resolveProfile("production-cloud");

  it("builds an internally distributed release APK, not a debug development client", () => {
    assert.equal(validation.distribution, "internal");
    assert.equal(validation.developmentClient, false);
    assert.equal(validation.android.buildType, "apk");
    assert.equal(validation.android.gradleCommand, undefined);
    assert.equal(validation.android.resourceClass, production.android.resourceClass);
  });

  it("retains the production toolchain, environment, API, and remote credentials", () => {
    for (const key of ["node", "pnpm", "environment", "credentialsSource"]) {
      assert.equal(validation[key], production[key]);
    }
    assert.equal(validation.credentialsSource, "remote");
    assert.deepEqual(validation.env, production.env);
    assert.equal(validation.android.image, production.android.image);
  });

  it("isolates updates and does not automatically alter local version identifiers", () => {
    assert.equal(validation.channel, "android-validation");
    assert.notEqual(validation.channel, production.channel);
    assert.equal(validation.autoIncrement, false);
    assert.equal(eas.cli.appVersionSource, "local");
    assert.equal(eas.submit["android-validation"], undefined);
  });

  it("leaves the Store profile as an AAB build", () => {
    assert.equal(production.distribution, "store");
    assert.equal(production.android.buildType, "app-bundle");
  });
});
