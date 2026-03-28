import React, { useState, useEffect } from "react";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function BrailleSpinner({ interval = 80 }: { interval?: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), interval);
    return () => clearInterval(id);
  }, [interval]);
  return <span>{BRAILLE_FRAMES[frame]}</span>;
}

export function ThinkingSpinner() {
  return (
    <div style={{ padding: "8px 16px", color: "#60a5fa", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
      <BrailleSpinner /> AI is thinking...
    </div>
  );
}
