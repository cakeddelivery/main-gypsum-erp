import Link from "next/link";
import type { ComplaintStatus, Prisma } from "@prisma/client";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, jakartaDateTime, jakartaParts, todayStr } from "@/lib/time";
import { complaintStatusOf, issueLabel, solutionLabel } from "@/lib/complaintShared";
import { marketplaceLabel } from "@/lib/returnLabel";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat, Tabs } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { ReturTabs } from "../ReturTabs";
import { ComplaintFields } from "./ComplaintFields";
import { saveComplaint } from "./actions";

export const metadata = { title: "Komplain & Refund" };

type SP = { tab?: string; q?: string };
const TABS: { key: string; label: string; where: Prisma.ComplaintWhereInput }[] = [
  { key: "proses", label: "Perlu tindakan", where: { cancelledAt: null, status: { in: ["DIAJUKAN", "DISETUJUI", "DIBAYAR", "DIKIRIM"] as ComplaintStatus[] } } },
  { key: "setuju", label: "Perlu disetujui", where: { cancelledAt: null, status: "DIAJUKAN", solution: "REFUND" } },
  { key: "bayar", label: "Siap dibayar", where: { cancelledAt: null, status: "DISETUJUI" } },
  { key: "selesai", label: "Selesai", where: { cancelledAt: null, status: "SELESAI" } },
  { key: "tolak", label: "Ditolak / batal", where: { OR: [{ status: "DITOLAK" }, { cancelledAt: { not: null } }] } },
];

export default async function KomplainPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("refund.request", "refund.approve", "refund.pay");
  const sp = await searchParams;
  const q = sp.q?.trim();
  const tab = TABS.find((t) => t.key === sp.tab) ?? (q ? { key: "semua", label: "Semua", where: {} } : TABS[0]);
  const where: Prisma.ComplaintWhereInput = { ...tab.where, ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { trackingNo: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } }, { orderNo: { contains: q, mode: "insensitive" } }] } : {}) };
  const p = jakartaParts();
  const monthStart = jakartaDateTime(`${p.year}-${String(p.month).padStart(2, "0")}-01`, "00:00");
  const canCreate = user.can("refund.request");
  const [rows, counts, paid, sent, items] = await Promise.all([
    prisma.complaint.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300, include: { lines: { include: { item: { select: { name: true } } }, orderBy: { sortOrder: "asc" } } } }),
    Promise.all(TABS.map((t) => prisma.complaint.count({ where: t.where }))),
    prisma.complaint.aggregate({ where: { cancelledAt: null, solution: "REFUND", paidAt: { gte: monthStart } }, _sum: { refundAmount: true }, _count: true }),
    prisma.complaint.aggregate({ where: { cancelledAt: null, solution: "KIRIM_GANTI", sentAt: { gte: monthStart } }, _sum: { replacementValue: true }, _count: true }),
    canCreate ? prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Komplain & Refund"
        subtitle="Komplain pembeli (pecah, kurang, kelengkapan). Solusi kirim ganti (stok keluar sebagai beban garansi) atau refund (disetujui & dibayar Finance)."
        actions={<>
          <DownloadCsv filename={`komplain-${todayStr()}`} rows={[["No.", "Tanggal", "Marketplace", "Resi", "No. pesanan", "Kota/Kab", "Provinsi", "Masalah", "Barang", "Solusi", "Refund", "Nilai pengganti", "Status"], ...rows.map((c) => [c.number, fmtDate(c.date), marketplaceLabel(c.marketplace), c.trackingNo ?? "", c.orderNo ?? "", c.city ?? "", c.province ?? "", issueLabel(c.issueType), c.lines.map((l) => `${l.item?.name ?? l.labelSku ?? l.labelName} × ${l.qty}`).join("; "), solutionLabel(c.solution), Number(c.refundAmount), Number(c.replacementValue), complaintStatusOf(c).label])]} />
          {canCreate && (
            <Modal trigger="+ Komplain" title="Komplain baru" full>
              <ModalForm action={saveComplaint}>
                <ComplaintFields items={items} today={todayStr()} />
                <div className="mt-4"><Submit>Simpan komplain</Submit></div>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      <ReturTabs current="komplain" can={user.can} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Refund dibayar (bulan ini)" value={idr(Number(paid._sum.refundAmount ?? 0))} hint={`${paid._count} komplain`} tone="red" />
        <Stat label="Barang pengganti (bulan ini)" value={idr(Number(sent._sum.replacementValue ?? 0))} hint={`${sent._count} kiriman`} tone="amber" />
        <Stat label="Perlu disetujui" value={`${counts[1]}`} tone={counts[1] ? "amber" : "slate"} href="/retur/komplain?tab=setuju" />
        <Stat label="Siap dibayar" value={`${counts[2]}`} tone={counts[2] ? "blue" : "slate"} href="/retur/komplain?tab=bayar" />
      </div>
      <Tabs current={tab.key} tabs={TABS.map((t, i) => ({ key: t.key, label: t.label, count: counts[i], href: `/retur/komplain?tab=${t.key}` }))} />
      <FilterBar>
        <input type="hidden" name="tab" value={sp.tab ?? ""} />
        <Field label="Cari"><input name="q" defaultValue={q} className="input" placeholder="No. komplain / resi / pesanan" /></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title="Belum ada komplain" hint={canCreate ? "Tekan + Komplain saat pembeli mengajukan komplain." : undefined} /> : (
        <Card title="Daftar komplain">
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Pesanan / resi</th><th>Masalah</th><th>Barang</th><th>Solusi</th><th className="num">Nilai</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((c) => {
                  const st = complaintStatusOf(c);
                  return (
                    <tr key={c.id}>
                      <td className="font-mono text-xs">{c.number}</td>
                      <td>{fmtDate(c.date)}</td>
                      <td className="text-xs"><div className="font-mono">{c.orderNo ?? c.trackingNo ?? "-"}</div><div className="text-slate-500">{marketplaceLabel(c.marketplace)}</div></td>
                      <td className="text-xs">{issueLabel(c.issueType)}</td>
                      <td className="text-xs">{c.lines.map((l) => `${l.item?.name ?? l.labelSku ?? l.labelName ?? "?"} × ${l.qty}`).join(", ")}</td>
                      <td className="text-xs">{solutionLabel(c.solution)}{c.bundleNext ? " (bareng pesanan berikut)" : ""}</td>
                      <td className="num">{c.solution === "REFUND" ? idr(Number(c.refundAmount)) : Number(c.replacementValue) ? idr(Number(c.replacementValue)) : "-"}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td><Link href={`/retur/komplain/${c.id}`} className="btn-secondary btn-sm">Detail</Link></td>
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
