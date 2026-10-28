import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime, jakartaDateTime } from "@/lib/time";
import { FilterBar, Field, PageHeader } from "@/components/ui";

export const metadata = { title: "Audit Trail" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; entity?: string; from?: string; to?: string; page?: string }> }) {
  await requirePerm("audit.view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const where = {
    ...(sp.entity ? { entity: sp.entity } : {}),
    ...(sp.q ? { OR: [{ action: { contains: sp.q, mode: "insensitive" as const } }, { actorName: { contains: sp.q, mode: "insensitive" as const } }, { entityId: { contains: sp.q } }] } : {}),
    ...(sp.from || sp.to ? { at: { ...(sp.from ? { gte: jakartaDateTime(sp.from, "00:00") } : {}), ...(sp.to ? { lt: new Date(jakartaDateTime(sp.to, "00:00").getTime() + 86400000) } : {}) } } : {}),
  };
  const [logs, entities, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, take: 100, skip: (page - 1) * 100 }),
    prisma.auditLog.groupBy({ by: ["entity"], _count: true }),
    prisma.auditLog.count({ where }),
  ]);
  const qs = (p: number) => "?" + new URLSearchParams({ ...(sp as Record<string, string>), page: String(p) }).toString();
  return (
    <div>
      <PageHeader title="Audit trail" subtitle="Append-only: catatan tidak dapat diubah atau dihapus (dijaga trigger database)" />
      <FilterBar>
        <Field label="Cari"><input name="q" defaultValue={sp.q} className="input" placeholder="Aksi / pengguna / ID" /></Field>
        <Field label="Entitas"><select name="entity" defaultValue={sp.entity ?? ""} className="input"><option value="">Semua</option>{entities.map((e) => <option key={e.entity} value={e.entity}>{e.entity} ({e._count})</option>)}</select></Field>
        <Field label="Dari"><input type="date" name="from" defaultValue={sp.from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="to" defaultValue={sp.to} className="input" /></Field>
      </FilterBar>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Entitas</th><th>Data</th></tr></thead>
          <tbody>{logs.map((l) => <tr key={String(l.id)}><td>{fmtDateTime(l.at)}</td><td>{l.actorName ?? "-"}</td><td className="font-medium">{l.action}</td><td className="text-xs">{l.entity}<div className="font-mono text-slate-400">{l.entityId}</div></td><td className="max-w-md whitespace-pre-wrap break-all font-mono text-[11px] text-slate-500">{l.data ? JSON.stringify(l.data).slice(0, 300) : ""}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-slate-500">{total.toLocaleString("id-ID")} catatan</span>
        <div className="flex gap-2">{page > 1 && <a className="btn-secondary btn-sm" href={qs(page - 1)}>← Sebelumnya</a>}{page * 100 < total && <a className="btn-secondary btn-sm" href={qs(page + 1)}>Berikutnya →</a>}</div>
      </div>
    </div>
  );
}
