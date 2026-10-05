// Android draws edge-to-edge (SDK 57+), so the window no longer shrinks for the keyboard and
// React Native's own keyboard events/KeyboardAvoidingView don't help there. On Android we follow
// the keyboard natively (react-native-keyboard-controller) and pad the bottom by its height, frame by
// frame, so the composer rides on top of the keyboard. iOS keeps KeyboardAvoidingView.
import React from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { KeyboardProvider, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** iOS only: height of anything above this view (header). */
  iosOffset?: number;
  /** Bottom padding the content already reserves (e.g. the gesture-bar inset); not added twice. */
  bottomInset?: number;
};

export function KeyboardRoot({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== "android") return <>{children}</>;
  return <KeyboardProvider>{children}</KeyboardProvider>;
}

export function KeyboardSafe({ children, style, iosOffset = 0, bottomInset = 0 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <KeyboardAvoidingView style={style} behavior="padding" keyboardVerticalOffset={iosOffset}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  if (Platform.OS !== "android") return <View style={style}>{children}</View>;
  return (
    <AndroidKeyboardSafe style={style} bottomInset={bottomInset}>
      {children}
    </AndroidKeyboardSafe>
  );
}

function AndroidKeyboardSafe({ children, style, bottomInset = 0 }: Omit<Props, "iosOffset">) {
  const { height } = useReanimatedKeyboardAnimation(); // 0 → -keyboardHeight
  const pad = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -height.value - bottomInset) }), [bottomInset]);
  return <Animated.View style={[style, pad]}>{children}</Animated.View>;
}
