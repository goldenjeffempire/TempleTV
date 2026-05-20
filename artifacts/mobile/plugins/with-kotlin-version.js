const { withGradleProperties } = require("@expo/config-plugins");

const KOTLIN_VERSION = "2.1.20";

module.exports = function withKotlinVersion(config) {
  return withGradleProperties(config, (mod) => {
    const props = mod.modResults;

    const existingIndex = props.findIndex(
      (p) => p.type === "property" && p.key === "kotlinVersion"
    );

    if (existingIndex >= 0) {
      props[existingIndex].value = KOTLIN_VERSION;
    } else {
      props.push({ type: "property", key: "kotlinVersion", value: KOTLIN_VERSION });
    }

    return mod;
  });
};
