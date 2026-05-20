import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

/**
 * Secure key/value storage for sensitive values like auth tokens.
 *
 * - Native (iOS/Android): expo-secure-store backed by Keychain / EncryptedSharedPreferences.
 * - Web: falls back to AsyncStorage (which uses localStorage). The auth token on web
 *   will be httpOnly-cookie-based in a future iteration.
 */
export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web") {
      return AsyncStorage.getItem(key);
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      await AsyncStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, {
      // AFTER_FIRST_UNLOCK allows auth tokens to be read in background
      // while the screen is locked (e.g. during background audio playback).
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY would silently fail token reads
      // whenever the user's screen is locked, breaking auto-refresh mid-stream.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === "web") {
      await AsyncStorage.removeItem(key);
      return;
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* swallow */
    }
  },
};
