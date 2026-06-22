"use client";

import { useEffect, useState } from "react";

// A controlled number input that lets the field go empty while you're editing
// (so backspace clears the whole thing) instead of snapping back to a min on
// every keystroke. Emits a rounded number as you type; clamps to [min,max] when
// you leave the field. ponytail: one component replaces the Math.max(1, +e...)
// inputs scattered across create + room that all had the same clear-bug.
export default function NumField({
  value,
  onChange,
  min = 1,
  max,
  className = "input",
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(String(value));
  // Re-sync when the value is changed from outside (e.g. a quick-pick button).
  useEffect(() => setText(String(value)), [value]);

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n));

  return (
    <input
      type="number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw); // allow "" / partial input — this is the fix
        if (raw === "") return; // don't emit until there's a number
        const n = Math.round(+raw);
        if (Number.isFinite(n)) onChange(n); // clamp deferred to blur so typing feels natural
      }}
      onBlur={() => {
        const n = Math.round(+text);
        const next = text === "" || !Number.isFinite(n) ? min : clamp(n);
        setText(String(next));
        onChange(next);
      }}
      className={className}
    />
  );
}
