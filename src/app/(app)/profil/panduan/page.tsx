import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { letterhead } from "@/lib/letterhead";
import { GUIDES, GUIDE_LIST, guideForTemplate, isGuideKind } from "@/lib/panduan";
import { memberDivision } from "@/lib/reportScope";
import { todayStr } from "@/lib/time";
import { PageHeader } from "@/components/ui";
import { PANDUAN_H, PANDUAN_W, PanduanSheet } from "@/components/PanduanSheet";
import { FitWidth } from "@/components/FitWidth";
import { DownloadJpg } from "@/components/DownloadJpg";

export const metadata = { title: "Panduan Divisi" };

/** Lembar Panduan divisi (A4, siap cetak): otomatis divisi pengguna; bisa pilih divisi lain */
export default async function PanduanPage({ searchParams }: { searchParams: Promise<{ divisi?: string }> }) {
  const user = await requireUser();
  const q = await searchParams;
  const divId = memberDivision(user);
  const div = divId ? await prisma.division.findUnique({ where: { id: divId }, select: { reportTemplate: true } }) : null;
  const own = guideForTemplate(div?.reportTemplate);
  const kind = isGuideKind(q.divisi) ? q.divisi : (own ?? "cetak");
  const guide = GUIDES[kind];
  const lh = await letterhead();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Panduan divisi"
        subtitle="Langkah harian memakai ERP, dari absen masuk sampai absen pulang. Bisa diunduh sebagai JPG siap cetak (A4)."
        actions={<DownloadJpg targetId="panduan-sheet" filename={`panduan-${kind}.jpg`} label="🖼️ Lihat & unduh JPG" className="btn-primary" />}
      />
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Pilih divisi">
        {GUIDE_LIST.map((g) => (
          <Link key={g.kind} href={`/profil/panduan?divisi=${g.kind}`} role="tab" aria-selected={g.kind === kind} className={g.kind === kind ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
            {g.name}{g.kind === own ? " (divisi Anda)" : ""}
          </Link>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <FitWidth width={PANDUAN_W} height={PANDUAN_H}>
          <PanduanSheet id="panduan-sheet" guide={guide} lh={lh} date={todayStr()} />
        </FitWidth>
      </div>
    </div>
  );
}
