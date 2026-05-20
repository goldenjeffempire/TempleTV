@echo off
REM Temple TV JCTM — Android Release Keystore Generator (Windows)
REM Run this ONCE from the artifacts/mobile directory.

set KEYSTORE_NAME=temple-tv-release.keystore
set KEY_ALIAS=temple-tv-key
set DEST=android

echo.
echo === Temple TV Android Release Keystore Generator ===
echo.
echo You will be asked for:
echo   1. A keystore password  (remember it)
echo   2. Your organisation info (can be approximate)
echo.

keytool -genkeypair -v ^
  -keystore "%DEST%\%KEYSTORE_NAME%" ^
  -alias "%KEY_ALIAS%" ^
  -keyalg RSA ^
  -keysize 2048 ^
  -validity 10000 ^
  -storetype PKCS12

echo.
echo Keystore created. Now enter your passwords to write keystore.properties:
echo.
set /p STORE_PASS=Enter the keystore password you just set: 
set /p KEY_PASS=Enter the key password you just set:      

(
echo storeFile=%KEYSTORE_NAME%
echo storePassword=%STORE_PASS%
echo keyAlias=%KEY_ALIAS%
echo keyPassword=%KEY_PASS%
) > "%DEST%\keystore.properties"

echo.
echo keystore.properties written to android\keystore.properties
echo.
echo IMPORTANT: Back up android\%KEYSTORE_NAME% and android\keystore.properties
echo            somewhere safe. Do NOT commit them to git.
echo.
echo Next: Open the android\ folder in Android Studio and build the release AAB.
pause
