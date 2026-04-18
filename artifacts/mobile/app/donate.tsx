import React from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";

interface DonationTier {
  label: string;
  description: string;
  icon: string;
  color: string;
}

const TIERS: DonationTier[] = [
  {
    label: "Seed Faith — ₦1,000",
    description: "Plant a seed of faith in the ministry",
    icon: "heart",
    color: "#E91E63",
  },
  {
    label: "Supporter — ₦5,000",
    description: "Support the broadcast of the Word",
    icon: "radio",
    color: "#9C27B0",
  },
  {
    label: "Partner — ₦10,000",
    description: "Partner with JCTM to reach more souls",
    icon: "users",
    color: "#3F51B5",
  },
  {
    label: "Kingdom Builder — ₦25,000",
    description: "Help fund equipment and platform expansion",
    icon: "star",
    color: "#FF9800",
  },
];

const GIVING_LINKS = [
  { label: "Give via Paystack", url: "https://paystack.com/pay/jctm-giving", icon: "credit-card" },
  { label: "Give via Flutterwave", url: "https://flutterwave.com/donate/jctm", icon: "gift" },
  { label: "Bank Transfer", url: "https://jctm.org.ng/give", icon: "briefcase" },
];

export default function DonateScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();

  const openLink = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Linking.openURL(url);
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: c.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Give / Donate</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.heroBanner, { backgroundColor: c.primary + "18" }]}>
          <View style={[styles.heroIcon, { backgroundColor: c.primary + "22" }]}>
            <Feather name="heart" size={36} color={c.primary} />
          </View>
          <Text style={[styles.heroTitle, { color: c.foreground }]}>
            Support the Ministry
          </Text>
          <Text style={[styles.heroSub, { color: c.mutedForeground }]}>
            Your generous giving helps Jesus Christ Temple Ministry (JCTM) broadcast
            the gospel, produce quality content, and reach souls across the world.
          </Text>
        </View>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>GIVING TIERS</Text>
        <GlassCard style={styles.tiersCard}>
          {TIERS.map((tier, i) => (
            <React.Fragment key={tier.label}>
              <View style={styles.tierRow}>
                <View style={[styles.tierIcon, { backgroundColor: tier.color + "1A" }]}>
                  <Feather name={tier.icon as any} size={18} color={tier.color} />
                </View>
                <View style={styles.tierText}>
                  <Text style={[styles.tierLabel, { color: c.foreground }]}>{tier.label}</Text>
                  <Text style={[styles.tierDesc, { color: c.mutedForeground }]}>{tier.description}</Text>
                </View>
              </View>
              {i < TIERS.length - 1 && (
                <View style={[styles.divider, { backgroundColor: c.border }]} />
              )}
            </React.Fragment>
          ))}
        </GlassCard>

        <Text style={[styles.sectionLabel, { color: c.mutedForeground }]}>GIVE NOW</Text>
        <GlassCard style={styles.linksCard}>
          {GIVING_LINKS.map((link, i) => (
            <React.Fragment key={link.label}>
              <Pressable
                onPress={() => openLink(link.url)}
                style={({ pressed }) => [styles.linkRow, { opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={[styles.linkIcon, { backgroundColor: c.secondary }]}>
                  <Feather name={link.icon as any} size={18} color={c.primary} />
                </View>
                <Text style={[styles.linkLabel, { color: c.foreground }]}>{link.label}</Text>
                <Feather name="external-link" size={14} color={c.mutedForeground} />
              </Pressable>
              {i < GIVING_LINKS.length - 1 && (
                <View style={[styles.divider, { backgroundColor: c.border }]} />
              )}
            </React.Fragment>
          ))}
        </GlassCard>

        <GlassCard style={[styles.accountCard, { marginTop: 0 }]}>
          <Text style={[styles.accountTitle, { color: c.foreground }]}>Bank Transfer Details</Text>
          <View style={[styles.accountRow, { marginTop: 10 }]}>
            <Text style={[styles.accountKey, { color: c.mutedForeground }]}>Bank</Text>
            <Text style={[styles.accountVal, { color: c.foreground }]}>First Bank of Nigeria</Text>
          </View>
          <View style={styles.accountRow}>
            <Text style={[styles.accountKey, { color: c.mutedForeground }]}>Account Name</Text>
            <Text style={[styles.accountVal, { color: c.foreground }]}>Jesus Christ Temple Ministry</Text>
          </View>
          <View style={styles.accountRow}>
            <Text style={[styles.accountKey, { color: c.mutedForeground }]}>Account No.</Text>
            <Text style={[styles.accountVal, { color: c.foreground }]}>Contact Us</Text>
          </View>
          <Text style={[styles.accountNote, { color: c.mutedForeground }]}>
            * Please contact us after transfer to confirm your giving.
          </Text>
        </GlassCard>

        {Platform.OS !== "web" && (
          <Pressable
            onPress={() => openLink("mailto:giving@jctm.org.ng")}
            style={({ pressed }) => [
              styles.contactBtn,
              { borderColor: c.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Feather name="mail" size={16} color={c.mutedForeground} />
            <Text style={[styles.contactText, { color: c.mutedForeground }]}>
              Questions? Contact our giving team
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 40 },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  scroll: { paddingHorizontal: 16, paddingTop: 20, gap: 0 },
  heroBanner: {
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    marginBottom: 28,
  },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  heroTitle: { fontSize: 22, fontFamily: "Inter_700Bold", marginBottom: 8, textAlign: "center" },
  heroSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
    marginBottom: 8,
    marginTop: 4,
  },
  tiersCard: { marginBottom: 24, overflow: "hidden" },
  tierRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  tierIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tierText: { flex: 1 },
  tierLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  tierDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 66 },
  linksCard: { marginBottom: 16, overflow: "hidden" },
  linkRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  linkIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  linkLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium" },
  accountCard: { padding: 16, marginBottom: 16 },
  accountTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  accountRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  accountKey: { fontSize: 13, fontFamily: "Inter_400Regular" },
  accountVal: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, textAlign: "right" },
  accountNote: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 12, lineHeight: 16 },
  contactBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
    padding: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  contactText: { fontSize: 14, fontFamily: "Inter_400Regular" },
});
