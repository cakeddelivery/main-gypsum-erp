import { headers } from "next/headers";

/** Alamat publik aplikasi dari header proxy (untuk tautan di QR); cadangan: env APP_URL */
export async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto")?.split(",")[0].trim();
    return `${proto === "http" || proto === "https" ? proto : host.startsWith("localhost") ? "http" : "https"}://${host}`;
  }
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}
