import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { BRAND, tailwindTokens, themeVars } from "./src/lib/themePalette";

const bd = tailwindTokens("bd");
const tx = tailwindTokens("tx");

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: { brand: BRAND },
      // Latar, teks, dan garis memakai variable yang ditukar saat mode malam, lihat src/lib/themePalette.ts
      backgroundColor: tailwindTokens("bg"),
      textColor: tx,
      borderColor: bd,
      ringColor: bd,
      placeholderColor: tx,
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root, .theme-light": themeVars("light"),
        '[data-theme="dark"]': themeVars("dark"),
      });
    }),
  ],
} satisfies Config;
