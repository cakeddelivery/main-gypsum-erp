import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { letterhead } from "@/lib/letterhead";
import { GUIDES, type GuideId } from "@/lib/panduan";
import { guideShots, guidesFor, pickGuide } from "@/lib/panduanAccess";
import { todayStr } from "@/lib/time";
import { PanduanSheet } from "@/components/PanduanSheet";
import { PrintBar } from "./PrintBar";

export const metadata = { title: "Cetak Panduan" };

/**
 * Lembar panduan siap cetak / simpan PDF: A4 tegak, margin 0, 1 halaman per panduan (teks tetap vektor).
 * ?g=semua (lebih dari satu panduan yang diizinkan) menggabungkan semua lembar dengan nomor halaman.
 */
export default async function CetakPanduan({ searchParams }: { searchParams: Promise<{ g?: string; print?: string }> }) {
  const user = await requireUser();
  const q = await searchParams;
  const { allowed, own } = await guidesFor(user);
  let ids: GuideId[];
  if (q.g === "semua") {
    if (allowed.length < 2) notFound();
    ids = allowed;
  } else {
    const id = pickGuide(q.g, allowed, own);
    if (!id || (q.g && q.g !== id)) notFound();
    ids = [id];
  }
  const lh = await letterhead();
  const shots = guideShots();
  const date = todayStr();
  return (
    <div className="cetak-panduan">
      <PrintBar auto={q.print === "1"} title={ids.length > 1 ? "Semua panduan" : GUIDES[ids[0]].title} />
      {ids.map((id, i) => (
        <section key={id} className="cetak-page">
          <PanduanSheet id={`panduan-${id}`} guide={GUIDES[id]} lh={lh} date={date} shots={shots} page={ids.length > 1 ? `Halaman ${i + 1} dari ${ids.length}` : undefined} />
        </section>
      ))}
    </div>
  );
}
