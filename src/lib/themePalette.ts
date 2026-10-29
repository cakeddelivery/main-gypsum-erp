/**
 * Palet warna berbasis CSS variable untuk mode terang & malam.
 *
 * Kelas Tailwind yang sudah ada (bg-white, text-slate-500, bg-emerald-50, …) tetap dipakai apa adanya;
 * nilai warnanya diambil dari variable yang ditukar saat <html data-theme="dark">. Warna latar, teks, dan garis
 * punya variable sendiri, sehingga misalnya `bg-white` jadi gelap di mode malam sementara `text-white`
 * di atas tombol tetap putih. Warna teks dipilih otomatis agar kontrasnya memenuhi WCAG AA (≥ 4.5:1).
 */
import colors from "tailwindcss/colors";

export const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;
type Shade = (typeof SHADES)[number];
type Palette = Record<Shade, string>;

export const BRAND: Palette = {
  50: "#f0f7ff", 100: "#dcecff", 200: "#bcd8ff", 300: "#8cbaf6", 400: "#5b93ea", 500: "#2f6fde",
  600: "#2559b8", 700: "#1d4690", 800: "#183a75", 900: "#13294f", 950: "#0b1830",
};

export const PALETTES: Record<string, Palette> = {
  slate: colors.slate as Palette,
  brand: BRAND,
  emerald: colors.emerald as Palette,
  rose: colors.rose as Palette,
  amber: colors.amber as Palette,
  violet: colors.violet as Palette,
  sky: colors.sky as Palette,
  orange: colors.orange as Palette,
};

/** Permukaan utama */
export const SURFACE = {
  light: { page: "#f8fafc", card: "#ffffff" },
  dark: { page: "#0b1120", card: "#111a2e", raised: "#1e293b" },
};

type RGB = [number, number, number];
export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Campur warna `a` di atas `b` dengan bobot `t` (0–1) */
export const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  return toHex([0, 1, 2].map((i) => x[i] * t + y[i] * (1 - t)) as RGB);
};
function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const idx = (s: Shade) => SHADES.indexOf(s);
/** Geser shade ke arah `dir` (+1 lebih gelap, -1 lebih terang) sampai kontras ke semua latar ≥ min */
function readable(p: Palette, start: Shade, dir: 1 | -1, bgs: string[], min: number) {
  let i = idx(start);
  while (i > 0 && i < SHADES.length - 1 && bgs.some((bg) => contrast(p[SHADES[i]], bg) < min)) i += dir;
  return p[SHADES[i]];
}

const DARK_TEXT_START: Record<Shade, Shade> = { 950: "100", 900: "100", 800: "200", 700: "300", 600: "400", 500: "400", 400: "400", 300: "500", 200: "600", 100: "700", 50: "800" };
const DARK_SLATE_BG: Partial<Record<Shade | "white", string>> = { white: SURFACE.dark.card, 50: "#172036", 100: "#1e293b", 200: "#283548", 300: "#334155", 400: "#475569" };
const DARK_SLATE_BORDER: Partial<Record<Shade, string>> = { 50: "#172036", 100: "#1c2639", 200: "#26334a", 300: "#334155", 400: "#475569" };
const DARK_TINT_BG: Partial<Record<Shade, number>> = { 50: 0.14, 100: 0.22, 200: 0.32, 300: 0.45 };
const DARK_TINT_BORDER: Partial<Record<Shade, number>> = { 50: 0.2, 100: 0.3, 200: 0.4, 300: 0.55 };

export type ThemeVars = Record<string, string>;
const rgbVar = (hex: string) => hexToRgb(hex).join(" ");

/** Hitung semua variable warna untuk satu mode */
export function themeVars(mode: "light" | "dark"): ThemeVars {
  const v: ThemeVars = {};
  v["--bg-white"] = rgbVar(mode === "light" ? SURFACE.light.card : SURFACE.dark.card);
  v["--bg-page"] = rgbVar(mode === "light" ? SURFACE.light.page : SURFACE.dark.page);
  for (const [name, p] of Object.entries(PALETTES)) {
    const slate = name === "slate";
    for (const s of SHADES) {
      let bg = p[s], border = p[s], text = p[s];
      if (mode === "light") {
        // Teks abu/berwarna yang terlalu pucat di atas putih digelapkan sampai terbaca
        const min = idx(s) >= idx("400") ? 4.5 : idx(s) === idx("300") ? 3 : 0;
        if (min) text = readable(p, s, 1, [SURFACE.light.card, SURFACE.light.page, p["50"]], min);
      } else {
        if (slate) {
          bg = DARK_SLATE_BG[s] ?? bg;
          border = DARK_SLATE_BORDER[s] ?? border;
        } else {
          if (DARK_TINT_BG[s] !== undefined) bg = mix(p["500"], SURFACE.dark.card, DARK_TINT_BG[s]!);
          if (DARK_TINT_BORDER[s] !== undefined) border = mix(p["500"], SURFACE.dark.card, DARK_TINT_BORDER[s]!);
        }
        const tint100 = slate ? DARK_SLATE_BG["100"]! : mix(p["500"], SURFACE.dark.card, DARK_TINT_BG["100"]!);
        const min = idx(s) >= idx("400") ? 4.5 : idx(s) === idx("300") ? 3 : 0;
        text = min ? readable(p, DARK_TEXT_START[s], -1, [SURFACE.dark.card, SURFACE.dark.raised, tint100], min) : p[DARK_TEXT_START[s]];
      }
      v[`--bg-${name}-${s}`] = rgbVar(bg);
      v[`--bd-${name}-${s}`] = rgbVar(border);
      v[`--tx-${name}-${s}`] = rgbVar(text);
    }
  }
  return v;
}

/** Nilai theme Tailwind (backgroundColor/textColor/borderColor) yang menunjuk ke variable */
export function tailwindTokens(kind: "bg" | "tx" | "bd") {
  const out: Record<string, string | Record<string, string>> = {};
  for (const name of Object.keys(PALETTES)) {
    out[name] = Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--${kind}-${name}-${s}) / <alpha-value>)`]));
  }
  if (kind === "bg") {
    out.white = "rgb(var(--bg-white) / <alpha-value>)";
    out.page = "rgb(var(--bg-page) / <alpha-value>)";
  }
  return out;
}
