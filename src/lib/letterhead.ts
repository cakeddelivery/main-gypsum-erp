import { prisma } from "@/lib/db";

export type Letterhead = { name: string; tagline: string; address: string; phone: string; city: string };

export const LETTERHEAD_DEFAULT: Letterhead = {
  name: "Main Gypsum",
  tagline: "Sahabat Kreatif Anak",
  address: "Jl. Sunan Giri Gang Beringin Indah no 3, Tumenggungan, Lamongan 6224",
  phone: "08974500707",
  city: "Lamongan",
};

/** Data kop surat untuk semua dokumen unduhan (Pengaturan → Parameter operasional) */
export async function letterhead(): Promise<Letterhead> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ["company_tagline", "company_address", "company_phone", "company_city"] } } });
  const v = (k: string) => rows.find((r) => r.key === k)?.value.trim() || "";
  return {
    name: LETTERHEAD_DEFAULT.name,
    tagline: v("company_tagline") || LETTERHEAD_DEFAULT.tagline,
    address: v("company_address") || LETTERHEAD_DEFAULT.address,
    phone: v("company_phone") || LETTERHEAD_DEFAULT.phone,
    city: v("company_city") || LETTERHEAD_DEFAULT.city,
  };
}
