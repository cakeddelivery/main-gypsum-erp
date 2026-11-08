import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { ProofPreview } from "@/components/ProofPreview";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Detail supplier" };

type Event = { key: string; date: Date; kind: "HUTANG" | "BAYAR" | "BELI"; label: React.ReactNode; debt: number; pay: number; proof: React.ReactNode };

export default async function SupplierDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("partner.view");
  const { id } = await params;
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) notFound();
  const [payables, purchases] = await Promise.all([
    prisma.payable.findMany({
      where: { supplierId: id },
      orderBy: { date: "asc" },
      include: { payments: { where: { status: "DIBUKUKAN", deletedAt: null }, orderBy: { date: "asc" }, select: { id: true, number: true, date: true, amount: true, payInterest: true, accountId: true, proofPath: true, proofMime: true, note: true } } },
    }),
    prisma.purchase.findMany({ where: { supplierId: id }, orderBy: { date: "desc" }, include: { lines: { include: { item: { select: { name: true, unit: true } } } } } }),
  ]);
  const banks = await prisma.bankAccount.findMany({ select: { id: true, name: true } });
  const bankName = (b: string | null) => banks.find((x) => x.id === b)?.name ?? "-";
  const purchaseOf = (payableId: string) => purchases.find((p) => p.payableId === payableId);
  const canFinance = user.can("finance.view");

  // Riwayat: hutang baru (+), pembayaran pokok (−), dan pembayaran langsung saat pembelian (tidak menambah hutang)
  const events: Event[] = [];
  for (const p of payables) {
    const pu = purchaseOf(p.id);
    events.push({
      key: `h${p.id}`,
      date: p.date,
      kind: "HUTANG",
      label: <>Hutang baru <span className="font-mono text-xs">{p.number}</span>{pu ? <> dari pembelian <span className="font-mono text-xs">{pu.number}</span></> : p.note ? ` · ${p.note}` : ""}</>,
      debt: Number(p.amount),
      pay: 0,
      proof: p.proofPath ? <ProofPreview src={`/api/files/payable-proof/${p.id}`} mime={p.proofMime} title={`Nota ${p.number}`} /> : pu?.proofPath && !pu.paidNow ? <ProofPreview src={`/api/files/purchase-proof/${pu.id}`} mime={pu.proofMime} title={`Bukti ${pu.number}`} /> : null,
    });
    for (const t of p.payments) {
      const principal = Number(t.amount - t.payInterest);
      events.push({
        key: `b${t.id}`,
        date: t.date,
        kind: "BAYAR",
        label: <>Bayar <span className="font-mono text-xs">{p.number}</span> · {canFinance ? <Link className="link font-mono text-xs" href={`/finance/${t.id}`}>{t.number}</Link> : <span className="font-mono text-xs">{t.number}</span>} dari {bankName(t.accountId)}{Number(t.payInterest) ? ` (+ bunga/biaya ${idr(t.payInterest)})` : ""}</>,
        debt: 0,
        pay: principal,
        proof: t.proofPath && canFinance ? <ProofPreview src={`/api/files/proof/${t.id}`} mime={t.proofMime} title={`Bukti ${t.number}`} /> : null,
      });
    }
    // Hutang lama yang dibayar sebelum ada catatan pembayaran (mis. hutang manual dengan Dibayar terisi)
    const recorded = p.payments.reduce((x, t) => x + Number(t.amount - t.payInterest), 0);
    const untracked = Number(p.paid) - recorded;
    if (untracked > 0) events.push({ key: `u${p.id}`, date: p.date, kind: "BAYAR", label: <>Pembayaran {p.number} (tercatat tanpa rincian transaksi)</>, debt: 0, pay: untracked, proof: null });
  }
  for (const pu of purchases) {
    if (pu.cancelledAt || !(pu.paidNow > BigInt(0))) continue;
    events.push({
      key: `p${pu.id}`,
      date: pu.date,
      kind: "BELI",
      label: <>{pu.term === "LUNAS" ? "Bayar lunas" : "DP"} pembelian <span className="font-mono text-xs">{pu.number}</span> dari {bankName(pu.bankAccountId)}</>,
      debt: 0,
      pay: 0,
      proof: pu.proofPath ? <ProofPreview src={`/api/files/purchase-proof/${pu.id}`} mime={pu.proofMime} title={`Bukti ${pu.number}`} /> : null,
    });
    // Nominal DP/lunas ditampilkan di kolom dibayar tapi tidak mengurangi sisa hutang
    events[events.length - 1].label = <>{events[events.length - 1].label} · <b>{idr(pu.paidNow)}</b></>;
  }
  events.sort((a, b) => a.date.getTime() - b.date.getTime() || (a.kind === "HUTANG" ? -1 : 1));
  let running = 0;
  const rows = events.map((e) => {
    running += e.debt - e.pay;
    return { ...e, balance: running };
  });

  const total = payables.reduce((x, p) => x + Number(p.amount), 0);
  const paid = payables.reduce((x, p) => x + Number(p.paid), 0);
  const bought = purchases.filter((p) => !p.cancelledAt).reduce((x, p) => x + Number(p.total), 0);
  return (
    <div className="space-y-4">
      <PageHeader title={s.name} subtitle={<>{s.code ?? ""}{s.aliases && <> · nama lain: {s.aliases}</>}{s.phone && <> · {s.phone}</>}{!s.active && <> · <Badge>Nonaktif</Badge></>}</>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sisa hutang" value={idr(total - paid)} tone={total - paid > 0 ? "amber" : "green"} />
        <Stat label="Total hutang" value={idr(total)} hint={`${payables.length} hutang`} />
        <Stat label="Sudah dibayar (pokok)" value={idr(paid)} />
        <Stat label="Total pembelian" value={idr(bought)} hint={`${purchases.filter((p) => !p.cancelledAt).length} pembelian`} />
      </div>

      <Card title="Hutang" actions={user.can("accounting.view") && <Link className="btn-secondary btn-sm" href="/akuntansi/piutang-utang?tab=utang">Bayar di Akuntansi ›</Link>}>
        {payables.length === 0 ? <Empty title="Belum ada hutang" /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Jatuh tempo</th><th>Asal</th><th className="num">Nominal</th><th className="num">Dibayar</th><th className="num">Sisa</th><th>Status</th></tr></thead>
              <tbody>
                {[...payables].reverse().map((p) => {
                  const rem = Number(p.amount - p.paid);
                  const pu = purchaseOf(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{p.number}</td><td>{fmtDate(p.date)}</td><td>{fmtDate(p.dueDate)}</td>
                      <td className="text-xs">{pu ? `Pembelian ${pu.number}` : "Input hutang"}</td>
                      <td className="num">{idr(p.amount)}</td><td className="num">{idr(p.paid)}</td><td className="num font-semibold">{idr(rem)}</td>
                      <td>{rem === 0 ? <Badge tone="green">Lunas</Badge> : p.dueDate && p.dueDate < new Date() ? <Badge tone="red">Jatuh tempo</Badge> : <Badge tone="amber">Belum lunas</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Riwayat hutang & pembayaran">
        {rows.length === 0 ? <Empty title="Belum ada riwayat" /> : (
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>Tanggal</th><th>Keterangan</th><th className="num">Hutang baru</th><th className="num">Bayar pokok</th><th className="num">Sisa hutang</th><th>Bukti</th></tr></thead>
              <tbody>
                {[...rows].reverse().map((e) => (
                  <tr key={e.key}>
                    <td className="whitespace-nowrap">{fmtDate(e.date)}</td>
                    <td>{e.label}</td>
                    <td className="num">{e.debt ? <span className="text-amber-700">+{idr(e.debt)}</span> : ""}</td>
                    <td className="num">{e.pay ? <span className="text-emerald-700">−{idr(e.pay)}</span> : ""}</td>
                    <td className="num font-semibold">{e.kind === "BELI" ? "" : idr(e.balance)}</td>
                    <td>{e.proof ?? <span className="text-slate-400">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></Paged>
          </div>
        )}
      </Card>

      <Card title="Pembelian">
        {purchases.length === 0 ? <Empty title="Belum ada pembelian" /> : (
          <div className="overflow-x-auto">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Item</th><th className="num">Tagihan</th><th className="num">Dibayar di awal</th><th>Status</th><th>Bukti</th></tr></thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id} className={p.cancelledAt ? "opacity-50" : ""}>
                    <td className="font-mono text-xs">{p.number}</td><td>{fmtDate(p.date)}</td>
                    <td className="text-xs">{p.lines.map((l) => `${l.item.name} ${Number(l.qty).toLocaleString("id-ID")} ${l.item.unit}`).join(", ")}</td>
                    <td className="num">{idr(p.total)}</td><td className="num">{idr(p.paidNow)}</td>
                    <td>{p.cancelledAt ? <Badge>Dibatalkan</Badge> : p.term === "LUNAS" ? <Badge tone="green">Lunas</Badge> : <Badge tone="amber">{p.term === "TEMPO" ? "Tempo" : "Bertahap"}</Badge>}</td>
                    <td>{p.proofPath ? <ProofPreview src={`/api/files/purchase-proof/${p.id}`} mime={p.proofMime} title={`Bukti ${p.number}`} /> : <span className="text-slate-400">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></Paged>
          </div>
        )}
      </Card>
    </div>
  );
}
