import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { letterhead } from "@/lib/letterhead";
import { GUIDES } from "@/lib/panduan";
import { guideShots, guidesFor, pickGuide } from "@/lib/panduanAccess";
import { todayStr } from "@/lib/time";
import { Empty, PageHeader } from "@/components/ui";
import { PanduanSheet } from "@/components/PanduanSheet";
import { PanduanView } from "@/components/PanduanView";
import { DocExport } from "@/components/DocSheet";
import { DownloadJpg } from "@/components/DownloadJpg";

export const metadata = { title: "Panduan" };

/**
 * Panduan penggunaan ERP. Anggota/kapten: panduan divisinya saja; Supervisor & Finance: panduan role-nya
 * (Supervisor juga panduan divisi); Owner: semua. Izin dicek di server, bukan hanya disembunyikan di menu.
 */
export default async function PanduanPage({ searchParams }: { searchParams: Promise<{ g?: string }> }) {
  const user = await requireUser();
  const { g } = await searchParams;
  const { allowed, own } = await guidesFor(user);
  const id = pickGuide(g, allowed, own);
  if (!id) {
    return (
      <div>
        <PageHeader title="Panduan" />
        <Empty title="Belum ada panduan untuk akun ini" hint="Akun belum terhubung ke divisi yang punya format laporan. Minta Owner mengatur divisi di data Karyawan." />
      </div>
    );
  }
  const guide = GUIDES[id];
  const lh = await letterhead();
  const shots = guideShots();
  return (
    <div className="space-y-4">
      <PageHeader
        title={allowed.length > 1 ? "Panduan" : guide.title}
        subtitle={guide.subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <DownloadJpg targetId="panduan-sheet" filename={`panduan-${id}.jpg`} label="🖼️ Unduh JPG" className="btn-secondary" />
            <a href={`/cetak/panduan?g=${id}&print=1`} target="_blank" rel="noopener" className="btn-secondary">📄 Unduh PDF / Cetak</a>
            {allowed.length > 1 && <a href="/cetak/panduan?g=semua&print=1" target="_blank" rel="noopener" className="btn-primary">📚 Unduh semua (PDF)</a>}
          </div>
        }
      />
      {allowed.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Pilih panduan">
          {allowed.map((x) => (
            <Link key={x} href={`/panduan?g=${x}`} role="tab" aria-selected={x === id} className={`whitespace-nowrap ${x === id ? "btn-primary btn-sm" : "btn-secondary btn-sm"}`}>
              {GUIDES[x].name}{x === own ? " ✓" : ""}
            </Link>
          ))}
        </div>
      )}
      <PanduanView guide={guide} wa={lh.phone} shots={shots} />
      {/* Lembar A4 (sumber sama) untuk unduhan JPG */}
      <DocExport>
        <PanduanSheet id="panduan-sheet" guide={guide} lh={lh} date={todayStr()} shots={shots} />
      </DocExport>
    </div>
  );
}
