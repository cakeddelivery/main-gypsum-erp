import type { MetadataRoute } from "next";
import { getUser } from "@/lib/auth";
import { buildManifest } from "@/lib/pwaManifest";

// Dibaca saat diminta agar nama/ikon staging mengikuti APP_ENV dan portal mengikuti peran yang login
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  return buildManifest((await getUser().catch(() => null))?.role);
}
