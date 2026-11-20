import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDateTime } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { undoImportAction } from "../actions";
import { MpNav } from "../MpNav";
import { SLOTS, slotStatus } from "@/lib/marketplace/slots";
import { ImportForm, type Card as SlotCard } from "./ImportForm";

export const metadata = { title: "Impor Marketplace" };
type Stats = { baru?: number; diperbarui?: number; dilewati?: number; withdrawals?: number; dibatalkan?: unknown };

export default async function ImporPage() {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const [stores, batches, status] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    prisma.marketplaceImport.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
    slotStatus(),
  ]);
  const cards: SlotCard[] = stores.flatMap((st) => (["SHP", "TTS"] as const).map((ch) => ({ storeId: st.id, storeName: st.name, channel: ch, slots: SLOTS[ch].map((sl) => { const x = status[`${st.id}|${ch}|${sl.key}`]; return { ...sl, lastAt: x?.lastAt ?? null, lastFile: x?.fileName ?? null, periodFrom: x?.periodFrom ?? null, periodTo: x?.periodTo ?? null }; }) })));
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  return (
    <div className="space-y-4">
      <PageHeader title="Impor Marketplace" subtitle="Unggah file Excel dari Seller Center Shopee & TikTok Shop" />
      <MpNav current="impor" />
      <Card title="Unggah file per slot"><ImportForm cards={cards} canManage={canManage} /></Card>
      <Card title="Riwayat impor">
        {batches.length === 0 ? (
          <Empty title="Belum ada impor" />
        ) : (
          <div className="table-wrap">
            <Paged size={10}>
              <table className="tbl">
                <thead><tr><th>Waktu</th><th>File</th><th>Toko / kanal</th><th>Hasil</th><th></th></tr></thead>
                <tbody>
                  {batches.map((b) => {
                    const s = (b.stats ?? {}) as Stats;
                    return (
                      <tr key={b.id} className={b.undoneAt ? "opacity-60" : ""}>
                        <td className="whitespace-nowrap">{fmtDateTime(b.createdAt)}<div className="text-xs text-slate-400">{b.createdBy}</div></td>
                        <td className="max-w-[14rem] break-all text-xs">{b.fileName}<div className="text-slate-400">{({ ORDER: "Pesanan", INCOME: "Penghasilan", BALANCE: "Buku Saldo Penjual", ADSBILL: "Saldo iklan" } as Record<string, string>)[b.kind] ?? b.kind}</div></td>
                        <td>{sn.get(b.storeId) ?? "-"} · {CHANNEL_LABEL[b.channel]}</td>
                        <td className="text-xs">{s.baru ?? 0} baru · {s.diperbarui ?? 0} diperbarui · {s.dilewati ?? 0} dilewati</td>
                        <td>
                          {b.undoneAt ? <Badge tone="gray">Dibatalkan</Badge> : canManage ? (
                            <ActionForm action={undoImportAction} confirm="Batalkan impor ini? Pesanan yang dibuat batch ini dihapus dan yang diperbarui dikembalikan seperti semula. Stok & jurnal tidak terpengaruh.">
                              <input type="hidden" name="id" value={b.id} />
                              <Submit className="btn-secondary" pendingText="Membatalkan…">Batalkan</Submit>
                            </ActionForm>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Paged>
          </div>
        )}
      </Card>
    </div>
  );
}
