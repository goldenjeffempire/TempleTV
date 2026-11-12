import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import {
  DailyDevotionRepository, DEVOTION_API, DEVOTION_CACHE_KEY,
} from "./dailyDevotionCore";

export const dailyDevotionRepository = new DailyDevotionRepository({
  now: Date.now,
  read: () => AsyncStorage.getItem(DEVOTION_CACHE_KEY),
  write: value => AsyncStorage.setItem(DEVOTION_CACHE_KEY, value),
  async fetch(signal) {
    // Browsers need a same-origin relay: JCTM correctly restricts API CORS.
    // Native Android fetches JCTM directly, so Temple API downtime does not
    // prevent access to today's devotion.
    const endpoint = Platform.OS === "web" ? "/mobile/temple-content/devotion" : DEVOTION_API;
    const response = await fetch(endpoint, {
      signal, cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" }, credentials: "omit",
    });
    if (!response.ok) throw new Error(`The official devotion service returned HTTP ${response.status}.`);
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("The official devotion service returned an invalid response.");
    }
    if (Number(response.headers.get("content-length") ?? "0") > 128_000) {
      throw new Error("The devotion response is too large.");
    }
    const text = await response.text();
    if (text.length > 128_000) throw new Error("The devotion response is too large.");
    return JSON.parse(text) as unknown;
  },
});
