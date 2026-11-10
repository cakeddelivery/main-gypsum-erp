/** Pengaturan aplikasi terpasang (PWA). Staging diberi nama & ikon berbeda agar tidak tertukar dengan aplikasi asli. */
export const isStaging = () => process.env.APP_ENV === "staging";

export function pwaInfo() {
  const tes = isStaging();
  const sfx = tes ? "-tes" : "";
  return {
    name: tes ? "Main Gypsum ERP (Tes)" : "Main Gypsum ERP",
    shortName: tes ? "MG ERP (Tes)" : "MG ERP",
    icon: (size: 96 | 192 | 512) => `/pwa/icon-${size}${sfx}.png`,
    maskable: `/pwa/maskable-512${sfx}.png`,
    apple: `/pwa/apple-180${sfx}.png`,
  };
}

/** Warna brand (sama dengan themeColor terang di layout) dan latar kuning logo */
export const PWA_THEME = "#2559b8";
export const PWA_BG = "#ffef00";
