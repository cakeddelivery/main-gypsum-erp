import Link from "next/link";
import type { Prisma, ReturnStatus } from "@prisma/client";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, jakartaParts, jakartaDateTime, todayStr } from "@/lib/time";
import { returnStatusOf } from "@/lib/returns";
import { marketplaceLabel } from "@/lib/returnLabel";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat, Tabs } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { ReturnFields } from "./ReturnFields";
import { saveReturn } from "./actions";

export const metadata = { title: "Retur" };

type SP = { tab?: string; q?: string };
const TABS: { key: string; label: string; where: Prisma.ReturnCaseWhereInput }[] = [
  { key: "aktif", label: "Belum selesai", where: { cancelledAt: null, status: { not: "SELESAI" } } },
  { key: "DITERIMA", label: "Diterima", where: { cancelledAt: null, status: "DITERIMA" } },
  { key: "DIPERIKSA", label: "Diperiksa", where: { cancelledAt: null, status: "DIPERIKSA" } },
  { key: "KLAIM", label: "Klaim", where: { cancelledAt: null, status: { in: ["KLAIM_DIAJUKAN", "KLAIM_CAIR", "KLAIM_DITOLAK"] as ReturnStatus[] } } },
  { key: "SELESAI", label: "Selesai", where: { cancelledAt: null, status: "SELESAI" } },
  { key: "BATAL", label: "Dibatalkan", where: { cancelledAt: { not: null } } },
];

export default async function ReturPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("retur.manage");
  const sp = await searchParams;
  const q = sp.q?.trim();
  const tab = TABS.find((t) => t.key === sp.tab) ?? (q ? { key: "semua", label: "Semua", where: {} } : TABS[0]);
  const where: Prisma.ReturnCaseWhereInput = {
    ...tab.where,
    ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { trackingNo: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } }, { orderNo: { contains: q, mode: "insensitive" } }, { city: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const p = jakartaParts();
  const monthStart = jakartaDateTime(`${p.year}-${String(p.month).padStart(2, "0")}-01`, "00:00");
  const [rows, counts, month, items] = await Promise.all([
    prisma.returnCase.findMany({
      where, orderBy: [{ receivedAt: "desc" }, { number: "desc" }], take: 300,
      include: { lines: { include: { item: { select: { name: true } } }, orderBy: { sortOrder: "asc" } }, media: { where: { kind: { in: ["THUMB", "VIDEO"] } }, select: { id: true, kind: true, status: true } } },
    }),
    Promise.all(TABS.map((t) => prisma.returnCase.count({ where: t.where }))),
    prisma.returnCase.aggregate({ where: { cancelledAt: null, receivedAt: { gte: monthStart } }, _count: true, _sum: { lossValue: true, goodValue: true, claimPaidAmount: true } }),
    prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Retur"
        subtitle="Paket retur dari pembeli marketplace: scan label resi, rekam video unboxing, periksa barang (baik kembali ke stok, rusak jadi kerugian), lalu klaim."
        actions={<>
          <DownloadCsv filename={`retur-${todayStr()}`} rows={[["No.", "Diterima", "Marketplace", "Kurir", "Resi", "No. pesanan", "Kota/Kab", "Provinsi", "Alasan", "Barang", "Nilai baik", "Kerugian", "Klaim cair", "Status"], ...rows.map((r) => [r.number, fmtDate(r.receivedAt), marketplaceLabel(r.marketplace), r.courier ?? "", r.trackingNo, r.orderNo ?? "", r.city ?? "", r.province ?? "", r.reason ?? "", r.lines.map((l) => `${l.item?.name ?? l.labelSku ?? l.labelName} × ${l.qty}`).join("; "), Number(r.goodValue), Number(r.lossValue), Number(r.claimPaidAmount), returnStatusOf(r).label])]} />
          <Modal trigger="+ Retur baru" title="Retur baru" full>
            <ModalForm action={saveReturn}>
              <ReturnFields items={items} today={todayStr()} />
              <div className="mt-4"><Submit>Simpan & rekam video</Submit></div>
            </ModalForm>
          </Modal>
        </>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Retur bulan ini" value={`${month._count} paket`} />
        <Stat label="Kembali ke stok" value={idr(Number(month._sum.goodValue ?? 0))} hint="nilai barang baik" tone="green" />
        <Stat label="Kerugian barang" value={idr(Number(month._sum.lossValue ?? 0))} hint="rusak / tidak ada di paket" tone="red" />
        <Stat label="Klaim cair" value={idr(Number(month._sum.claimPaidAmount ?? 0))} tone="blue" />
      </div>
      <Tabs current={tab.key} tabs={TABS.map((t, i) => ({ key: t.key, label: t.label, count: counts[i], href: `/retur?tab=${t.key}` }))} />
      <FilterBar>
        <input type="hidden" name="tab" value={sp.tab ?? ""} />
        <Field label="Cari"><input name="q" defaultValue={q} className="input" placeholder="No. retur / resi / pesanan / kota" /></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title="Belum ada retur" hint="Tekan + Retur baru saat paket retur datang." /> : (
        <Card title="Daftar retur">
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>Video</th><th>No.</th><th>Diterima</th><th>Resi</th><th>Tujuan</th><th>Barang</th><th className="num">Kerugian</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = returnStatusOf(r);
                  const thumb = r.media.find((m) => m.kind === "THUMB" && m.status === "READY");
                  const video = r.media.find((m) => m.kind === "VIDEO" && m.status !== "DELETED" && m.status !== "FAILED");
                  return (
                    <tr key={r.id}>
                      <td>{thumb ? <img src={`/api/files/retur-media/${thumb.id}`} alt="" loading="lazy" className="h-10 w-14 rounded object-cover" /> : <span className="text-xs text-slate-400">{video ? (video.status === "UPLOADING" ? "mengunggah" : "proses") : "belum"}</span>}</td>
                      <td className="font-mono text-xs">{r.number}</td>
                      <td>{fmtDate(r.receivedAt)}</td>
                      <td><div className="font-mono text-xs">{r.trackingNo}</div><div className="text-xs text-slate-500">{marketplaceLabel(r.marketplace)}{r.courier ? ` · ${r.courier}` : ""}</div></td>
                      <td className="text-xs">{[r.city, r.province].filter(Boolean).join(", ") || "-"}</td>
                      <td className="text-xs">{r.lines.map((l) => `${l.item?.name ?? l.labelSku ?? l.labelName ?? "?"} × ${l.qty}`).join(", ")}</td>
                      <td className="num">{Number(r.lossValue) ? idr(Number(r.lossValue)) : "-"}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td><Link href={`/retur/${r.id}`} className="btn-secondary btn-sm">Detail</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></Paged>
          </div>
        </Card>
      )}
    </div>
  );
}
