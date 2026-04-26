#!/usr/bin/env bash
# Temple TV JCTM — Android Release Keystore Generator
# Run this ONCE from the artifacts/mobile directory to create the production keystore.
# Keep the generated .keystore file and the passwords SECURE — losing them means
# you can never update the app on Google Play with the same listing.

set -e

KEYSTORE_NAME="temple-tv-release.keystore"
KEY_ALIAS="temple-tv-key"
DEST="android"

echo ""
echo "=== Temple TV Android Release Keystore Generator ==="
echo ""
echo "You will be asked for:"
echo "  1. A keystore password  (remember it — needed for every release build)"
echo "  2. A key password       (can be the same as keystore password)"
echo "  3. Your organisation info (can be approximate)"
echo ""

keytool \
  -genkeypair \
  -v \
  -keystore "${DEST}/${KEYSTORE_NAME}" \
  -alias "${KEY_ALIAS}" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storetype PKCS12

echo ""
echo "Keystore created at: android/${KEYSTORE_NAME}"
echo ""
read -s -p "Enter the keystore password you just set: " STORE_PASS
echo ""
read -s -p "Enter the key password you just set:      " KEY_PASS
echo ""

cat > "${DEST}/keystore.properties" <<EOF
storeFile=${KEYSTORE_NAME}
storePassword=${STORE_PASS}
keyAlias=${KEY_ALIAS}
keyPassword=${KEY_PASS}
EOF

echo "keystore.properties written to: android/keystore.properties"
echo ""
echo "IMPORTANT: Back up android/${KEYSTORE_NAME} and android/keystore.properties"
echo "           somewhere safe (e.g. 1Password, encrypted drive)."
echo "           Do NOT commit either file to git — they are already in .gitignore."
echo ""
echo "Next step: open the android/ folder in Android Studio and build the release AAB."
