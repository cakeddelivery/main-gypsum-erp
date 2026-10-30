import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePerm, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { alertsFor } from "@/lib/alerts";
import { productionSummary, productionTrend, productivity, financeMonth, financeTrend, salesByStore } from "@/lib/dashboard";
import { bankBalances } from "@/lib/finance";
import { idr } from "@/lib/money";
import { dateOnly, fmtDay, MONTHS, todayStr } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/rbac";
import { STAGE_LABEL } from "@/lib/stock";
import { ATT_LABEL } from "@/lib/attendance";
import { Badge, Card, PageHeader, Stat, Tabs } from "@/components/ui";
import { BarsChart, TrendChart } from "@/components/Charts";

export const metadata = { title: "Dashboard" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  // Koordinator borongan langsung ke halaman titiknya
  if ((await requireUser()).role === "KOORDINATOR") redirect("/borongan");
  const user = await requirePerm("dashboard.view");
  const sp = await searchParams;
  const today = todayStr();
  const role = user.role;
  const isOperator = role === "OPERATOR";
  const isCaptain = role === "KAPTEN_DIVISI";
  const scope = isOperator ? { employeeId: user.employeeId ?? "__none__" } : isCaptain ? { divisionId: user.divisionId } : {};
  const showFinance = user.can("dashboard.finance");
  const showProduction = user.can("production.view");
  const stores = await prisma.store.findMany({ orderBy: { code: "asc" } });
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : null;

  const [alerts, prod, trend, people, fin, finTrend, banks, sales, attendance] = await Promise.all([
    alertsFor(user.can, isCaptain ? user.divisionId : null),
    showProduction ? productionSummary(today, scope) : null,
    showProduction ? productionTrend(14, scope) : null,
    showProduction && !isOperator ? productivity(today, isCaptain ? user.divisionId : null) : null,
    showFinance ? financeMonth(storeId) : null,
    showFinance ? financeTrend(14, storeId) : null,
    showFinance ? bankBalances() : null,
    role === "ADMIN_MARKETPLACE" || role === "OWNER" || role === "FINANCE" ? salesByStore() : null,
    user.employeeId ? prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(today) } }, include: { shift: true } }) : null,
  ]);

  const greeting = role === "OWNER" ? "Ringkasan analitik bisnis" : isOperator ? "Pekerjaan Anda hari ini" : "Tindakan & ringkasan hari ini";

  return (
    <div className="space-y-5">
      <PageHeader title={`Halo, ${user.name.split(" ")[0]}`} subtitle={`${ROLE_LABEL[role]} · ${greeting} · ${fmtDay(dateOnly(today))}`} />

      {/* Admin & role lapangan: fokus tindakan — notifikasi di atas */}
      {role !== "OWNER" && <AlertList alerts={alerts} />}

      {(isOperator || isCaptain || role === "PIC_CONTENT") && user.employeeId && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Absensi hari ini" value={attendance ? ATT_LABEL[attendance.status] : "Belum absen"} tone={attendance ? (attendance.status === "TERLAMBAT" ? "amber" : "green") : "red"} hint={attendance ? attendance.shift.name : "Ketuk untuk absen"} href="/absensi" />
          {prod && <Stat label="Hasil saya hari ini" value={`${prod.good} pcs`} hint={prod.target ? `Target ${prod.target}` : undefined} tone="blue" href="/produksi" />}
          {prod && <Stat label="Reject" value={`${prod.reject} pcs`} hint={`${prod.rejectRate}%`} tone={prod.reject ? "red" : "slate"} />}
          <Link href="/produksi?baru=1" className="card flex items-center justify-center p-4 text-center text-sm font-semibold text-brand-700 hover:bg-brand-50">+ Input hasil produksi</Link>
        </div>
      )}

      {showFinance && fin && (
        <>
          <Tabs current={storeId ?? "all"} tabs={[{ key: "all", label: "Konsolidasi", href: "/" }, ...stores.map((s) => ({ key: s.id, label: s.name, href: `/?store=${s.id}` }))]} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={`Pemasukan ${MONTHS[fin.month - 1]}`} value={idr(fin.income)} tone="green" href="/finance?status=DIBUKUKAN" />
            <Stat label={`Pengeluaran ${MONTHS[fin.month - 1]}`} value={idr(fin.expense)} tone="red" href="/finance?status=DIBUKUKAN" />
            <Stat label="Laba rugi bulan ini" value={idr(fin.pl.netProfit)} tone={fin.pl.netProfit >= 0 ? "green" : "red"} hint={`Pendapatan ${idr(fin.pl.totalRevenue)}`} href="/akuntansi/laba-rugi" />
            <Stat label="Total saldo rekening" value={idr(banks!.reduce((s, b) => s + b.balance, 0))} tone="blue" hint={`${banks!.length} rekening`} href="/akuntansi/buku-besar" />
          </div>
        </>
      )}

      {showProduction && prod && !isOperator && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label={isCaptain ? "Produksi divisi hari ini" : "Produksi hari ini"} value={`${prod.good.toLocaleString("id-ID")} pcs`} href="/produksi" />
          <Stat label="Target harian" value={`${prod.target.toLocaleString("id-ID")} pcs`} hint={prod.target ? `Tercapai ${Math.round((prod.achieved / prod.target) * 100)}%` : "Belum diatur"} tone={prod.target && prod.achieved >= prod.target ? "green" : "amber"} />
          <Stat label="Barang jadi" value={`${prod.finished.toLocaleString("id-ID")} pcs`} tone="blue" />
          <Stat label="Reject" value={`${prod.reject.toLocaleString("id-ID")} pcs`} hint={`${prod.rejectRate}% dari total`} tone={prod.rejectRate > 5 ? "red" : "slate"} />
          <Stat label="Karyawan produktif" value={people?.length ?? 0} hint="mencatat hasil hari ini" />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {trend && (
          <Card title="Tren produksi 14 hari">
            <BarsChart data={trend} series={[{ key: "hasil", label: "Hasil", color: "#2f6fde" }, { key: "reject", label: "Reject", color: "#e11d48" }]} />
          </Card>
        )}
        {finTrend && (
          <Card title="Tren pemasukan & pengeluaran 14 hari">
            <TrendChart data={finTrend} series={[{ key: "masuk", label: "Pemasukan", color: "#059669" }, { key: "keluar", label: "Pengeluaran", color: "#e11d48" }]} />
          </Card>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {banks && (
          <Card title="Saldo rekening">
            <ul className="divide-y divide-slate-100 text-sm">
              {banks.map((b) => (
                <li key={b.id} className="flex justify-between py-2">
                  <span>{b.name}</span>
                  <span className="font-medium tabular-nums">{idr(b.balance)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {sales && (
          <Card title="Withdraw marketplace bulan ini">
            <ul className="divide-y divide-slate-100 text-sm">
              {sales.map((s) => (
                <li key={s.store} className="flex justify-between py-2">
                  <span>{s.store} <span className="text-xs text-slate-400">({s.count} trx)</span></span>
                  <span className="font-medium tabular-nums">{idr(s.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-400">Dari withdraw saldo penjual (transfer internal) yang sudah dibukukan, per toko.</p>
          </Card>
        )}
        {prod && prod.byStage.length > 0 && (
          <Card title="Hasil per tahap hari ini">
            <ul className="divide-y divide-slate-100 text-sm">
              {prod.byStage.map((s) => (
                <li key={s.stage} className="flex justify-between py-2">
                  <span>{STAGE_LABEL[s.stage]}</span>
                  <span className="tabular-nums">
                    {s._sum.qtyGood ?? 0} <span className="text-rose-500">/ {s._sum.qtyReject ?? 0} rj</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {people && people.length > 0 && (
          <Card title="Produktivitas karyawan hari ini" className="lg:col-span-1">
            <ul className="divide-y divide-slate-100 text-sm">
              {people.slice(0, 8).map((p) => (
                <li key={p.name} className="flex items-center justify-between py-2">
                  <span>
                    {p.name} <span className="text-xs text-slate-400">{p.division}</span>
                  </span>
                  <span className="tabular-nums">
                    {p.good}
                    {p.target > 0 && <span className="text-xs text-slate-400"> / {p.target}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {role === "OWNER" && <AlertList alerts={alerts} />}
    </div>
  );
}

function AlertList({ alerts }: { alerts: Awaited<ReturnType<typeof alertsFor>> }) {
  return (
    <div id="notifikasi">
      {alerts.length === 0 ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">✓ Tidak ada pekerjaan tertunda.</p>
      ) : (
        <Card title="Notifikasi & pekerjaan tertunda">
          <ul className="grid gap-2 sm:grid-cols-2">
            {alerts.map((a) => (
              <li key={a.key}>
                <Link href={a.href} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                  <span>{a.label}</span>
                  <Badge tone={a.tone}>{a.count}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
