import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { AppHeader } from "@/components/AppHeader";
import { usePageSeo } from "@/hooks/usePageSeo";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

interface ContactItem {
  label: string;
  value: string;
  icon: FeatherName;
  onPress?: () => void;
  copyable?: boolean;
}

const EMAILS: ContactItem[] = [
  {
    label: "General",
    value: "info@jctm.org.ng",
    icon: "mail",
    onPress: () => Linking.openURL("mailto:info@jctm.org.ng").catch(() => {}),
  },
  {
    label: "Ministry",
    value: "jesuschristtempleministry@jctm.org.ng",
    icon: "mail",
    onPress: () =>
      Linking.openURL("mailto:jesuschristtempleministry@jctm.org.ng").catch(() => {}),
  },
  {
    label: "New Members",
    value: "joinus@jctm.org.ng",
    icon: "mail",
    onPress: () => Linking.openURL("mailto:joinus@jctm.org.ng").catch(() => {}),
  },
  {
    label: "Support",
    value: "support@jctm.org.ng",
    icon: "mail",
    onPress: () => Linking.openURL("mailto:support@jctm.org.ng").catch(() => {}),
  },
  {
    label: "Prophet Amos",
    value: "prophetamos@jctm.org.ng",
    icon: "mail",
    onPress: () =>
      Linking.openURL("mailto:prophetamos@jctm.org.ng").catch(() => {}),
  },
];

const PHONES: ContactItem[] = [
  {
    label: "Enquiries",
    value: "+234 (0) 808 131 3111",
    icon: "phone",
    onPress: () =>
      Linking.openURL("tel:+2348081313111").catch(() => {}),
  },
  {
    label: "Enquiries",
    value: "07082009777",
    icon: "phone",
    onPress: () =>
      Linking.openURL("tel:+2347082009777").catch(() => {}),
  },
];

const ONLINE: ContactItem[] = [
  {
    label: "YouTube",
    value: "youtube.com/@TEMPLETVJCTM",
    icon: "youtube",
    onPress: () =>
      Linking.openURL("https://youtube.com/@TEMPLETVJCTM").catch(() => {}),
  },
  {
    label: "Website",
    value: "jctm.org.ng",
    icon: "globe",
    onPress: () =>
      Linking.openURL("https://jctm.org.ng").catch(() => {}),
  },
];

const SERVICE_INFO: ContactItem[] = [
  {
    label: "Sunday Service",
    value: "Live-streamed · 8:00 AM WAT",
    icon: "tv",
  },
  {
    label: "Zoom Meeting ID",
    value: "4092099631",
    icon: "video",
    onPress: () =>
      Linking.openURL("https://zoom.us/j/4092099631").catch(() => {}),
  },
];

function SectionTitle({ title }: { title: string }) {
  const c = useColors();
  return (
    <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>
      {title}
    </Text>
  );
}

function ContactRow({ item }: { item: ContactItem }) {
  const c = useColors();
  const isInteractive = !!item.onPress;

  return (
    <Pressable
      onPress={
        item.onPress
          ? () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              item.onPress?.();
            }
          : undefined
      }
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: c.border },
        pressed && isInteractive && { opacity: 0.65 },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: c.muted }]}>
        <Feather name={item.icon} size={16} color={c.primary} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: c.mutedForeground }]}>
          {item.label}
        </Text>
        <Text
          style={[
            styles.rowValue,
            { color: isInteractive ? c.primary : c.foreground },
          ]}
          numberOfLines={2}
        >
          {item.value}
        </Text>
      </View>
      {isInteractive && (
        <Feather name="chevron-right" size={16} color={c.mutedForeground} />
      )}
    </Pressable>
  );
}

export default function ContactScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  usePageSeo({ title: "Contact", description: "Get in touch with Jesus Christ Temple Ministry, Ebrumede Roundabout, Effurun, Delta State, Nigeria.", path: "/contact" });

  const openMaps = () => {
    const query = encodeURIComponent(
      "Jesus Christ Temple Ministry, Ebrumede Roundabout, Effurun, Delta State, Nigeria",
    );
    Linking.openURL(`https://maps.google.com/?q=${query}`).catch(() => {});
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <AppHeader title="Contact & Location" />

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + 32 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Church Address ── */}
        <SectionTitle title="CHURCH ADDRESS" />
        <GlassCard style={styles.card}>
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              openMaps();
            }}
            style={({ pressed }) => [
              styles.addressBlock,
              pressed && { opacity: 0.65 },
            ]}
          >
            <View style={styles.addressTop}>
              <View style={[styles.rowIcon, { backgroundColor: c.muted }]}>
                <Feather name="map-pin" size={16} color={c.primary} />
              </View>
              <Text style={[styles.addressName, { color: c.foreground }]}>
                Jesus Christ Temple Ministry
              </Text>
            </View>
            <Text style={[styles.addressLines, { color: c.mutedForeground }]}>
              {"Land of Good News\nKm 1 East West Road,\nPatani Expressway,\nEbrumede Roundabout, Effurun,\nDelta State, Nigeria"}
            </Text>
            <View style={styles.directionsRow}>
              <Feather name="navigation" size={13} color={c.primary} />
              <Text style={[styles.directionsText, { color: c.primary }]}>
                Tap for directions
              </Text>
            </View>
          </Pressable>
        </GlassCard>

        {/* ── Email ── */}
        <SectionTitle title="EMAIL US" />
        <GlassCard style={styles.card}>
          {EMAILS.map((item, i) => (
            <View
              key={item.value}
              style={i < EMAILS.length - 1 ? undefined : styles.lastRow}
            >
              <ContactRow item={item} />
            </View>
          ))}
        </GlassCard>

        {/* ── Phone ── */}
        <SectionTitle title="PHONE & MEDIA" />
        <GlassCard style={styles.card}>
          {PHONES.map((item, i) => (
            <View
              key={item.value}
              style={i < PHONES.length - 1 ? undefined : styles.lastRow}
            >
              <ContactRow item={item} />
            </View>
          ))}
        </GlassCard>

        {/* ── Online ── */}
        <SectionTitle title="ONLINE" />
        <GlassCard style={styles.card}>
          {ONLINE.map((item, i) => (
            <View
              key={item.value}
              style={i < ONLINE.length - 1 ? undefined : styles.lastRow}
            >
              <ContactRow item={item} />
            </View>
          ))}
        </GlassCard>

        {/* ── Services ── */}
        <SectionTitle title="SERVICES" />
        <GlassCard style={styles.card}>
          {SERVICE_INFO.map((item, i) => (
            <View
              key={item.label + item.value}
              style={i < SERVICE_INFO.length - 1 ? undefined : styles.lastRow}
            >
              <ContactRow item={item} />
            </View>
          ))}
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  headerSpacer: { width: 30 },

  scroll: { paddingHorizontal: 16, paddingTop: 20 },

  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
    marginLeft: 4,
  },

  card: { marginBottom: 20, padding: 0, overflow: "hidden" },

  addressBlock: { padding: 16, gap: 10 },
  addressTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  addressName: { flex: 1, fontSize: 15, fontWeight: "700" },
  addressLines: { fontSize: 13, lineHeight: 20, marginLeft: 4 },
  directionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 2,
    marginLeft: 4,
  },
  directionsText: { fontSize: 13, fontWeight: "600" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lastRow: { borderBottomWidth: 0 },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3, marginBottom: 2 },
  rowValue: { fontSize: 13, fontWeight: "500" },
});
