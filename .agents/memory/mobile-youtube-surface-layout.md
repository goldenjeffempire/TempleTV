---
name: Mobile YouTube surface layout
description: Layout rules that prevent app-added dark bands around the native embedded YouTube player.
---

The visible player shell, native YouTube iframe, loading thumbnail, and fallback thumbnail must use one authoritative rectangle. When the route supplies a shell height, the native player must use it exactly; only use responsive 16:9 sizing when no explicit height exists.

**Why:** Independent height caps left part of the black shell visible around the iframe. Separately, opaque React Native views placed above the WebView to hide YouTube chrome created the dark strips shown to users and obscured the intended native-player presentation.

**How to apply:** Pass the shell's live/VOD height to every visible YouTube embed, let thumbnails fill that rectangle, keep transient overlays non-interactive, and never add opaque caps over the WebView to hide YouTube controls. Preserve the iframe's own control/fullscreen/touch configuration.