// Pairing deep link: …/--/connect?url=http://mac:47321&token=… (printed as a QR by `npm run pair`).
import { Redirect, useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useStore } from "../lib/store";
import { useTheme } from "../lib/theme";

export default function Connect() {
  const { url, token } = useLocalSearchParams<{ url?: string; token?: string }>();
  const { setConn } = useStore();
  const t = useTheme();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (url) setConn({ url: String(url), token: String(token ?? "") }).then(() => setDone(true));
    else setDone(true);
  }, [url, token, setConn]);
  if (done) return <Redirect href="/" />;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.panel }}>
      <ActivityIndicator color={t.faint} />
    </View>
  );
}
