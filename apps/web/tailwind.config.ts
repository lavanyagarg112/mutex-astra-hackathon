import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["DM Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      boxShadow: {
        shell: "0 24px 70px rgba(24, 24, 27, 0.10)",
        float: "0 16px 40px rgba(24, 24, 27, 0.14)",
      },
      colors: { ink: "#191918", signal: "#F1B44C" },
    },
  },
  plugins: [],
} satisfies Config;
