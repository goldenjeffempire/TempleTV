import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { submitPrayerRequest } from "@/services/api";

export function PrayerSection() {
  const c = useColors();
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  if (submitted) {
    return (
      <View style={[styles.prayerCard, { backgroundColor: c.card, borderColor: "#22c55e30" }]}>
        <View style={styles.prayerSuccessRow}>
          <View style={[styles.prayerSuccessIcon, { backgroundColor: "#22c55e18" }]}>
            <Text style={{ fontSize: 22 }}>🙏</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[styles.prayerSentTitle, { color: c.foreground }]}>
              Your prayer has been received
            </Text>
            <Text style={[styles.prayerSentSub, { color: c.mutedForeground }]}>
              Our prayer team is interceding for you right now
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.prayerCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.prayerHeader}>
        <View style={[styles.prayerIconWrap, { backgroundColor: c.primary + "18" }]}>
          <Text style={{ fontSize: 20 }}>🕊️</Text>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[styles.prayerTitle, { color: c.foreground }]}>
            Send a Prayer Request
          </Text>
          <Text style={[styles.prayerSubtitle, { color: c.mutedForeground }]}>
            Our team will pray for you during the service
          </Text>
        </View>
      </View>

      <Pressable
        onPress={() => {
          setSending(true);
          submitPrayerRequest(null, "Praying with Temple TV")
            .then((ok) => {
              if (!isMountedRef.current) return;
              setSending(false);
              if (ok) setSubmitted(true);
            })
            .catch(() => {
              if (!isMountedRef.current) return;
              setSending(false);
            });
        }}
        style={({ pressed }: { pressed: boolean }) => [
          styles.prayerBtn,
          { backgroundColor: c.primary, opacity: sending || pressed ? 0.76 : 1 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Send prayer request"
      >
        <Feather name="send" size={15} color="#fff" />
        <Text style={styles.prayerBtnText}>
          {sending ? "Sending…" : "Send Prayer Request"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  prayerCard: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 14 },
  prayerHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  prayerIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  prayerTitle: { fontSize: 15, fontWeight: "800", letterSpacing: -0.2 },
  prayerSubtitle: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  prayerBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 13, borderRadius: 12,
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18, shadowRadius: 6, elevation: 3,
  },
  prayerBtnText: { fontSize: 15, fontWeight: "800", color: "#fff", letterSpacing: 0.1 },
  prayerSuccessRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  prayerSuccessIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  prayerSentTitle: { fontSize: 14, fontWeight: "700" },
  prayerSentSub: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
