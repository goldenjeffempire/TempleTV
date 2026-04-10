import React, { useMemo, useState } from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { CategoryPills } from "@/components/CategoryPills";
import { SermonCard } from "@/components/SermonCard";
import { SERMONS } from "@/data/sermons";
import type { SermonCategory } from "@/types";
import type { Sermon } from "@/types";

export default function LibraryScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<SermonCategory>("All");
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const filtered = useMemo(() => {
    let results = SERMONS;
    if (category !== "All") {
      results = results.filter((s) => s.category === category);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      results = results.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preacher.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }
    return results;
  }, [search, category]);

  const handleSermonPress = (sermon: Sermon) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
      pathname: "/player",
      params: {
        videoId: sermon.youtubeId,
        title: sermon.title,
        preacher: sermon.preacher,
        duration: sermon.duration,
      },
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View style={{ paddingTop: insets.top + webTopPad }}>
        <Text style={[styles.header, { color: c.foreground }]}>Sermon Library</Text>
        <Text style={[styles.count, { color: c.mutedForeground }]}>
          {filtered.length} sermon{filtered.length !== 1 ? "s" : ""}
        </Text>

        <View style={[styles.searchContainer, { backgroundColor: c.muted, borderColor: c.border }]}>
          <Feather name="search" size={18} color={c.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: c.foreground }]}
            placeholder="Search sermons, preachers..."
            placeholderTextColor={c.mutedForeground}
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <Feather
              name="x"
              size={18}
              color={c.mutedForeground}
              onPress={() => setSearch("")}
            />
          )}
        </View>

        <CategoryPills selected={category} onSelect={setCategory} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <SermonCard sermon={item} onPress={handleSermonPress} variant="horizontal" />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather name="search" size={48} color={c.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: c.foreground }]}>No sermons found</Text>
            <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
              Try a different search or category
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  count: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    paddingHorizontal: 16,
    marginTop: 2,
    marginBottom: 12,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    padding: 0,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 140,
    gap: 10,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
});
