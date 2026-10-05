// zedthreads://inbox (widgets) → the sidebar in "Needs you" mode.
import { Redirect } from "expo-router";
import React from "react";

export default function Inbox() {
  return <Redirect href="/?mode=inbox" />;
}
