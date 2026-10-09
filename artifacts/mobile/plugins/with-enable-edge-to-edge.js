// Expo Config Plugin — enableEdgeToEdge() for Android 15
//
// Android 15 (API 35) deprecated the old theme-attribute approach to edge-to-edge
// (android:statusBarColor, android:navigationBarColor, etc.).  The modern replacement
// is a single call to enableEdgeToEdge() from androidx.activity, added to
// MainActivity.onCreate() BEFORE super.onCreate().
//
// This plugin injects:
//   import androidx.activity.enableEdgeToEdge
//   enableEdgeToEdge()     ← before super.onCreate(savedInstanceState)
//
// into the generated MainActivity.kt. Dependency compatibility branches can
// still appear in Play's static report; this does not promise a clean report.
//
// Works alongside with-edge-to-edge.js which:
//   • retains android:windowLayoutInDisplayCutoutMode="always" (still valid in API 36)
//   • strips android:windowOptOutEdgeToEdgeEnforcement (deprecated in API 36)
//   • strips android:statusBarColor / android:navigationBarColor (deprecated in API 35)

const { withMainActivity } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withEnableEdgeToEdge(config) {
  return withMainActivity(config, (mod) => {
    const { language, contents } = mod.modResults;
    if (language !== "kt") return mod;

    let src = contents;

    // 1. Add import if not already present — insert before the first `import expo.modules`
    //    line (which is always present in Expo-generated MainActivity.kt).
    if (!src.includes("import androidx.activity.enableEdgeToEdge")) {
      src = src.replace(
        /(import expo\.modules\.)/,
        "import androidx.activity.enableEdgeToEdge\n$1",
      );
    }

    // 2. Inject enableEdgeToEdge() before super.onCreate().
    //    We target the exact pattern Expo generates and guard against double-injection.
    if (!src.includes("enableEdgeToEdge()")) {
      // Primary pattern: super.onCreate(savedInstanceState) on its own line.
      if (src.includes("super.onCreate(savedInstanceState)")) {
        src = src.replace(
          /(\s*)(super\.onCreate\(savedInstanceState\))/,
          "$1enableEdgeToEdge()\n$1$2",
        );
      } else if (src.includes("super.onCreate(null)")) {
        // Fallback: some templates pass null.
        src = src.replace(
          /(\s*)(super\.onCreate\(null\))/,
          "$1enableEdgeToEdge()\n$1$2",
        );
      }
    }

    // Set RN's public edge-to-edge flag before ReactActivity initializes its
    // window or JS StatusBar starts hiding/showing bars. Older Android keeps
    // its existing compatibility behavior.
    if (!src.includes("setEdgeToEdgeFeatureFlagOn()")) {
      if (!src.includes("enableEdgeToEdge()")) {
        throw new Error("Edge-to-edge plugin: MainActivity onCreate pattern changed");
      }
      src = src.replace(
        /^([ \t]*)enableEdgeToEdge\(\)/m,
        "$1if (android.os.Build.VERSION.SDK_INT >= 35) {\n$1  setEdgeToEdgeFeatureFlagOn()\n$1}\n$1enableEdgeToEdge()",
      );
    }
    if (!src.includes("import com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn")) {
      src = src.replace(
        "import androidx.activity.enableEdgeToEdge",
        "import androidx.activity.enableEdgeToEdge\nimport com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn",
      );
    }
    if (!src.includes("import androidx.activity.enableEdgeToEdge") ||
        !src.includes("setEdgeToEdgeFeatureFlagOn()")) {
      throw new Error("Edge-to-edge plugin: could not configure Kotlin MainActivity");
    }
    mod.modResults.contents = src;
    return mod;
  });
};
