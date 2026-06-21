import type { Config } from "tailwindcss";

// Design tokens lifted directly from the PokerNight clickable prototype
// (PokerNight.dc.html). Keep these in sync with that source of truth.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // surfaces
        ink: "#0c120e", // page background
        screen: "#141c17", // app screen background
        panel: "#161e18", // drawers / modals
        "panel-2": "#1a231d",
        field: "#1b251e", // inputs / list rows
        "field-2": "#161e18",
        bar: "#101813", // bottom action bar gradient base
        // felt + wood
        felt: "#2f6e51",
        "felt-deep": "#1c4434",
        "felt-card": "#21503c", // card backs
        wood: "#2a2018",
        // amber accent
        amber: "#e0a23b",
        "amber-soft": "#caa86a",
        "amber-deep": "#b9842a",
        "amber-ink": "#1a1206", // text on amber
        // text
        cream: "#f1ede4",
        "cream-2": "#cdd6cf",
        muted: "#8b9a8f",
        "muted-2": "#5d6b62",
        "muted-3": "#9aa79d",
        "muted-4": "#a7b3aa",
        // green status
        green: "#6db86d",
        "green-soft": "#9fd29f",
        // red / fold / live
        red: "#c0392b",
        clay: "#d4654f",
        "clay-soft": "#e8826f",
        "live-red": "#e25c47",
        "live-soft": "#f0a293",
        // playing-card face
        "card-face": "#f4f1e8",
        "card-ink": "#23201c",
        "card-red": "#c0392b",
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        body: ["'Manrope'", "sans-serif"],
      },
      keyframes: {
        "pn-pulse": {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(224,162,59,.45)" },
          "50%": { boxShadow: "0 0 0 7px rgba(224,162,59,0)" },
        },
        "pn-blink": { "0%,100%": { opacity: "1" }, "50%": { opacity: ".3" } },
        "pn-fade": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pn-up": {
          from: { transform: "translateY(40px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "pn-pop": {
          from: { transform: "scale(.92)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        // win-animation tiers (build prompt §14)
        "pn-confetti": {
          to: { transform: "translateY(420px) rotate(540deg)", opacity: "0" },
        },
        "pn-flip": {
          "0%,100%": { transform: "rotateY(0deg)" },
          "50%": { transform: "rotateY(180deg)" },
        },
        // one-shot reveal: card flips around from edge to face
        "pn-flip-in": {
          "0%": { transform: "rotateY(-180deg)", opacity: "0" },
          "50%": { opacity: "1" },
          "100%": { transform: "rotateY(0deg)", opacity: "1" },
        },
        // board deal: card travels at full size as a back, then flips face-up.
        // Pure rotation, no scale — so the rank/suit never change size visually
        // (relies on a working 3D context + backface-visibility on the faces).
        "pn-deal-card": {
          "0%,45%": { transform: "rotateY(0deg)" },
          "100%": { transform: "rotateY(180deg)" },
        },
        // burnt card going up in flames at the burn spot
        "pn-burn": {
          "0%": { opacity: "1", filter: "brightness(1)" },
          "55%": { opacity: "1", filter: "brightness(.75) sepia(1) saturate(4) hue-rotate(-18deg)" },
          "100%": { opacity: "0", transform: "scale(.65) translateY(7px)", filter: "brightness(.2)" },
        },
        "pn-flame": {
          "0%": { opacity: "0", transform: "translateY(3px) scale(.6)" },
          "35%": { opacity: "1" },
          "100%": { opacity: "0", transform: "translateY(-18px) scale(1.15)" },
        },
        "pn-bounce": {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-22px)" },
        },
        "pn-glow": {
          "0%,100%": { transform: "scale(1)", filter: "brightness(1)" },
          "50%": { transform: "scale(1.12)", filter: "brightness(1.4)" },
        },
        "pn-flash": { "0%,100%": { opacity: "0" }, "50%": { opacity: "1" } },
        // action chat bubbles
        "pn-bubble": {
          from: { transform: "scale(.5) translateY(6px)", opacity: "0" },
          to: { transform: "scale(1) translateY(0)", opacity: "1" },
        },
        "pn-smoke": {
          from: { transform: "translateY(0) scale(.5)", opacity: ".7" },
          to: { transform: "translateY(-16px) scale(1.9)", opacity: "0" },
        },
        "pn-point": {
          "0%,100%": { transform: "translateX(0)" },
          "50%": { transform: "translateX(-3px)" },
        },
        "pn-rise": {
          "0%": { transform: "translateY(4px)", opacity: "0" },
          "30%": { opacity: "1" },
          "100%": { transform: "translateY(-14px)", opacity: "0" },
        },
        "pn-slam": {
          "0%": { transform: "scale(3.2)", opacity: "0" },
          "55%": { transform: "scale(.82)", opacity: "1" },
          "78%": { transform: "scale(1.12)" },
          "100%": { transform: "scale(1)" },
        },
        "pn-shake": {
          "0%,100%": { transform: "translate(-50%, 0)" },
          "25%": { transform: "translate(calc(-50% - 3px), 0)" },
          "75%": { transform: "translate(calc(-50% + 3px), 0)" },
        },
        // max-seats stepper value pop (direction depends on +/-)
        "pn-pop-up": {
          "0%": { transform: "translateY(7px) scale(.6)", opacity: "0" },
          "60%": { transform: "translateY(-3px) scale(1.15)" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        "pn-pop-down": {
          "0%": { transform: "translateY(-7px) scale(.6)", opacity: "0" },
          "60%": { transform: "translateY(3px) scale(1.15)" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        // pre-showdown card shake
        "pn-jitter": {
          "0%,100%": { transform: "translate(0,0) rotate(0deg)" },
          "25%": { transform: "translate(-2px,1px) rotate(-3deg)" },
          "75%": { transform: "translate(2px,-1px) rotate(3deg)" },
        },
        // win-animation badge holds, then zips up & fades out (so it stops
        // covering the cards on small screens). Duration is set per-tier inline.
        "pn-zip-out": {
          "0%,68%": { opacity: "1", transform: "translateY(0) scale(1)" },
          "100%": { opacity: "0", transform: "translateY(-44px) scale(.7)" },
        },
        // loser tears falling
        "pn-drip": {
          "0%": { transform: "translateY(0) scale(.6)", opacity: "0" },
          "20%": { opacity: "1" },
          "100%": { transform: "translateY(26px) scale(1)", opacity: "0" },
        },
      },
      animation: {
        "pn-pulse": "pn-pulse 1.8s infinite",
        "pn-blink": "pn-blink 1.5s infinite",
        "pn-fade": "pn-fade .35s ease",
        "pn-up": "pn-up .4s ease",
        "pn-pop": "pn-pop .3s ease",
        "pn-flip": "pn-flip 1.2s ease infinite",
        "pn-flip-in": "pn-flip-in .6s ease both",
        "pn-deal-card": "pn-deal-card 520ms ease-out both",
        "pn-bounce": "pn-bounce .9s ease infinite",
        "pn-glow": "pn-glow 1.4s ease infinite",
        "pn-flash": "pn-flash 2.5s ease infinite",
        "pn-bubble": "pn-bubble .25s ease-out",
        "pn-point": "pn-point .4s ease-in-out 3",
        "pn-rise": "pn-rise 1.1s ease-out infinite",
        "pn-slam": "pn-slam .5s cubic-bezier(.2,1.5,.4,1) forwards",
        "pn-jitter": "pn-jitter .18s ease-in-out infinite",
        "pn-zip-out": "pn-zip-out 2s ease-in forwards",
        "pn-drip": "pn-drip 1.4s ease-in infinite",
      },
    },
  },
  plugins: [],
};

export default config;
