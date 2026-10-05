// zedthreads://new?cwd=… (Quick start widget) → the new-thread sheet for that project.
import { Redirect, useLocalSearchParams } from "expo-router";
import React from "react";

export default function NewThread() {
  const { cwd } = useLocalSearchParams<{ cwd?: string }>();
  return <Redirect href={cwd ? `/?new=${encodeURIComponent(String(cwd))}` : "/"} />;
}
