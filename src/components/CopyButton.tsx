"use client";

import { useState } from "react";

export function CopyButton({
  text,
  label = "복사",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);

  async function onCopy() {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }

  return (
    <button type="button" onClick={onCopy} className="btn-ghost">
      {done ? "복사됨 ✓" : label}
    </button>
  );
}
