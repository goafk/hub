// Phone layout: a thread pushed on top of the sidebar.
import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { NewThreadSheet } from "../../components/Dialogs";
import { ThreadView } from "../../components/ThreadView";
import { useStore } from "../../lib/store";

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { select } = useStore();
  const [newIn, setNewIn] = useState<string | null>(null);
  return (
    <>
      <ThreadView
        id={String(id)}
        onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        onNewThread={(cwd) => setNewIn(cwd)}
        onReviewChanges={(cwd) => router.push(`/changes?cwd=${encodeURIComponent(cwd)}`)}
      />
      <NewThreadSheet
        cwd={newIn}
        onClose={() => setNewIn(null)}
        onCreated={(th) => {
          setNewIn(null);
          select(th.id);
          router.replace(`/thread/${encodeURIComponent(th.id)}`);
        }}
      />
    </>
  );
}
