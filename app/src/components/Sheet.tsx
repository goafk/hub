// Bottom sheet (phone) / centered popover (wide) used for dropdowns and dialogs.
import React from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ui, useTheme } from "../lib/theme";

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  return (
    <Modal visible={visible} transparent animationType={wide ? "fade" : "slide"} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={[st.backdrop, { backgroundColor: t.dark ? "rgba(0,0,0,0.45)" : "rgba(76,79,105,0.25)" }, wide && st.center]} onPress={onClose}>
          <Pressable
            onPress={() => {}}
            style={[
              st.card,
              { backgroundColor: t.surface, borderColor: t.border, paddingBottom: wide ? 12 : Math.max(insets.bottom, 12) },
              wide ? st.cardWide : st.cardSheet,
            ]}
          >
            {!wide ? <View style={[st.grabber, { backgroundColor: t.borderStrong }]} /> : null}
            {title ? <Text style={[st.title, { color: t.muted }]}>{title}</Text> : null}
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  center: { justifyContent: "center", alignItems: "center" },
  card: { borderWidth: StyleSheet.hairlineWidth, maxHeight: "80%" },
  cardSheet: { borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingTop: 8 },
  cardWide: { width: 420, borderRadius: 10, paddingTop: 12 },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: 8 },
  title: { fontSize: 13, fontFamily: ui, paddingHorizontal: 18, paddingVertical: 8, textTransform: "uppercase", letterSpacing: 0.6 },
});
