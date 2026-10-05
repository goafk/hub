// Review changes for a project (pushed from a thread's menu or a project row).
import { router, useLocalSearchParams } from "expo-router";
import React from "react";
import { ChangesView } from "../components/ChangesView";

export default function ChangesScreen() {
  const { cwd } = useLocalSearchParams<{ cwd: string }>();
  return <ChangesView cwd={String(cwd)} onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))} />;
}
