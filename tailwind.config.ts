import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 50: "#f0f7ff", 100: "#dcecff", 500: "#2f6fde", 600: "#2559b8", 700: "#1d4690", 900: "#13294f" },
      },
    },
  },
  plugins: [],
} satisfies Config;
