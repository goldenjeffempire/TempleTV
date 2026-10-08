---
name: Local Android Gradle builds
description: Nix SDK availability, cold-build timing and secure signing verification lessons.
---

An SDK missing from the system package installer's index is not proof that a
local Android build is impossible. Nix's androidenv composition can supply
SDK/NDK/CMake packages with Nix-compatible executable loaders.

**Why:** The installer rejected the Android SDK attribute as absent from its
index, but direct Nix composition successfully installed the requested native
toolchain. Unmodified downloaded Linux executables may not run on NixOS.

**How to apply:** Check available Nix attributes and use versions required by
the current installed React Native and Android build configuration. Do not
assume old remembered SDK versions or store paths still apply.

A Nix-composed SDK is read-only; include library-specific NDK requirements,
not only React Native's default.

**Why:** Expo Updates requested a different NDK revision and Gradle's automatic
installation failed against the read-only SDK. The secondary missing release
component error was only a consequence of that configuration failure.

**How to apply:** Diagnose the first Gradle exception. Compose a superset of
required NDK versions instead of changing a dependency's compiler requirement
or trying to write into the Nix store.

Do not classify a short initial Gradle timeout as a hung or unsupported build.

**Why:** A cold native build spent several minutes compiling Gradle's Kotlin
plugins and was making progress after shorter attempts timed out.

**How to apply:** Use a background build and progress logs, bounded workers and
appropriate heap limits. Let initial plugin compilation finish before
diagnosing a missing SDK or application-level compile failure.

Verify encrypted signing material and its public certificate, not merely
the existence of signing secrets. Prefer the verified existing local signing
profile over an unvalidated backup; do not silently generate a replacement key.

**Why:** An available Base64 signing backup decoded into an invalid keystore,
whereas the existing local profile opened and matched the known Play-compatible
reference. Switching to another key would make the release unusable on Play.

**How to apply:** Consume credentials only inside build processes. Return
validation status, not aliases/passwords/private material. Compare against a
known accepted certificate and fail closed on mismatches.

Disable JVM performance counters for local release builds in this container.

**Why:** The Gradle launcher crashed with SIGBUS in
`PerfLongVariant::sample()` after successful Kotlin compilation, without any
cgroup OOM events. Performance-counter sampling is unrelated to app behavior.

**How to apply:** Set `JAVA_TOOL_OPTIONS=-XX:-UsePerfData` for the build process
and include the flag in Gradle's JVM arguments. Keep signal reporting in build
errors so a terminated JVM is not mistaken for a compilation failure.

Serialize native compilation and R8 in the constrained local build.

**Why:** Two Gradle workers with project parallelism let C++ compilation and R8
overlap, and the container recorded an OOM kill despite a bounded Java heap.

**How to apply:** Use one Gradle worker, disable project parallelism, and limit
CMake parallelism. Keep production minification and resource shrinking enabled;
do not reduce release quality just to avoid build-time memory pressure.

Disable the local Gradle build cache when packaging native release symbols.

**Why:** Cache packing hit a disk quota despite ample filesystem space after
successful compilation. Filesystem free space does not prove cache quota headroom.

**How to apply:** Use `--no-build-cache`, keeping existing task outputs for
incremental builds. Do not delete compiled native outputs or disable debug symbols.

Expo cloud builds can be requested through the Expo MCP integration without
running the forbidden EAS CLI.

**Why:** The MCP build action supports GitHub-backed builds, but connecting
Expo or GitHub to Replit does not link a GitHub repository to the Expo project.
An authenticated build request can still fail because Expo has no linked repo.
An Expo account name is not evidence of an organization-only repository
restriction: a personal GitHub repository worked after the project link became
active, without transferring the repository or changing the Expo project.
Changing from local to remote credentials can silently select a different
signing certificate; a successful cloud build was rejected by Google Play even
though the original upload keystore was valid.

**How to apply:** Check the repository's actual release source before queuing.
Use a separate release branch and disable auto-submit. If Expo reports no
repository for the project, the user must link it in Expo's GitHub settings.
Verify account type and the actual project link before recommending a repository
transfer; do not infer account type from a team-like name.
Cloud profiles use Expo-managed credentials; keep private local signing files
out of GitHub and let EAS inject signing rather than the local Gradle wrapper.
For an existing Play app, verify the selected remote upload certificate against
Play's expected fingerprint before queuing. A correct local backup does not
prove Expo's remote default uses the same key. If the connected tools cannot
upload credentials, have the user update them securely in Expo; do not repeat
a build with a known wrong key or generate a replacement.
