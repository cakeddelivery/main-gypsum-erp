import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { skuOverview } from "@/lib/marketplace/report";
import { groupOf, suggestProducts, type SuggestOption } from "@/lib/marketplace/skuSuggest";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Tabs } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { MpNav } from "../MpNav";
import { SkuRow } from "./SkuRow";

export const metadata = { title: "Pemetaan SKU Marketplace" };
type SP = { tab?: string; toko?: string; kanal?: string; q?: string };
const TABS = ["belum", "sudah", "extra", "semua"] as const;

/** Kiri: SKU + nama produk dalam 1 baris (dipotong, tooltip penuh) + jumlah pesanan */
function Info({ r, label, badge, target }: { r: { orders: number; sample?: { name: string | null } }; label: string; badge?: React.ReactNode; target?: string }) {
  const title = `${label} · ${r.sample?.name ?? ""} · ${r.orders} pesanan`;
  return (
    <div className="min-w-0 max-w-[26rem]" title={title}>
      <p className="truncate text-sm font-medium">{label} {badge}</p>
      <p className="truncate text-xs text-slate-500">{r.sample?.name ?? "-"} · {r.orders} pesanan</p>
      {target && <p className="truncate text-xs font-medium text-emerald-700">→ {target}</p>}
    </div>
  );
}

export default async function SkuPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const sp = await searchParams;
  const [rows, itemRows, stores] = await Promise.all([
    skuOverview(),
    prisma.item.findMany({
      where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true, product: { select: { store: { select: { code: true } }, family: { select: { name: true } }, variantValues: { select: { option: { select: { name: true } } } } } } },
    }),
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
  ]);
  const options: SuggestOption[] = itemRows.map((i) => ({ id: i.id, name: i.name, group: groupOf(i.name, i.product?.family?.name), storeCode: i.product?.store?.code ?? null, words: [i.sku, ...(i.product?.variantValues.map((v) => v.option.name) ?? [])] }));
  const items = options.map((o) => ({ id: o.id, name: o.name, group: o.group }));

  // filter toko, kanal, cari; hitungan tab mengikuti filter ini
  const q = (sp.q ?? "").trim().toLowerCase();
  const label = (r: (typeof rows)[number]) => [r.sample?.sku, r.sample?.variation].filter(Boolean).join(" · ") || r.key;
  const base = rows.filter((r) =>
    (!sp.toko || r.storeIds.includes(sp.toko)) && (!sp.kanal || r.channels.includes(sp.kanal)) &&
    (!q || `${r.key} ${r.sample?.sku ?? ""} ${r.sample?.variation ?? ""} ${r.sample?.name ?? ""}`.toLowerCase().includes(q)));
  const lists = {
    belum: base.filter((r) => !r.resolved),
    sudah: base.filter((r) => r.resolved?.kind === "PRODUK"),
    extra: base.filter((r) => r.resolved?.kind === "EXTRA_PACKING"),
    semua: base,
  };
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : "belum";
  const href = (t: string) => { const p = new URLSearchParams(); p.set("tab", t); for (const k of ["toko", "kanal", "q"] as const) if (sp[k]) p.set(k, sp[k]!); return `?${p}`; };
  const list = lists[tab];
  return (
    <div className="space-y-4">
      <PageHeader title="Pemetaan SKU" subtitle="Pilih sekali, diingat seterusnya · dipakai bersama menu Retur" />
      <MpNav current="sku" />
      <p className="text-sm text-slate-500">“12 MIX”, “12MIX”, dan “MG-12MIX” dibaca sebagai SKU yang sama. Extra Packing (Bubble Wrap, Extra Dus) adalah pendapatan tambahan, bukan produk jadi: tidak masuk penjualan produk. Saran produk muncul di urutan teratas (toko yang benar dulu).</p>
      <Tabs current={tab} tabs={[
        { key: "belum", label: "Belum dipetakan", count: lists.belum.length, href: href("belum") },
        { key: "sudah", label: "Sudah dikenali", count: lists.sudah.length, href: href("sudah") },
        { key: "extra", label: "Extra Packing", count: lists.extra.length, href: href("extra") },
        { key: "semua", label: "Semua", count: lists.semua.length, href: href("semua") },
      ]} />
      <FilterBar>
        <input type="hidden" name="tab" value={tab} />
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Kanal"><select name="kanal" defaultValue={sp.kanal ?? ""} className="input"><option value="">Semua</option><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
        <Field label="Cari SKU / nama" className="col-span-2"><input name="q" defaultValue={sp.q ?? ""} placeholder="mis. 24-MIX, BBWP, Giftbox" className="input" /></Field>
      </FilterBar>
      <Card title={`${{ belum: "Belum dipetakan", sudah: "Sudah dikenali", extra: "Extra Packing", semua: "Semua SKU" }[tab]} (${list.length}) · urut jumlah pesanan`}>
        {list.length === 0 ? <Empty title={tab === "belum" ? "Semua SKU sudah dikenali" : "Tidak ada SKU"} hint="Ubah filter toko, kanal, atau kata cari bila perlu." /> : (
          <div className="table-wrap">
            <Paged size={10}>
              <table className="tbl">
                <thead><tr><th>SKU · produk marketplace</th><th>Toko</th><th className="num">Pesanan</th><th>Dipetakan ke</th></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const res = r.resolved;
                    const sugg = !res && r.sample ? suggestProducts({ sku: r.sample.sku, variation: r.sample.variation, name: r.sample.name, storeCodes: r.storeCodes }, options).map((o) => o.id) : [];
                    return (
                      <tr key={r.key}>
                        <td><Info r={r} label={label(r)} target={res ? (res.kind === "PRODUK" ? res.itemName : `Extra Packing${res.variant ? ` · ${res.variant}` : ""}`) : undefined} badge={res ? (res.kind === "PRODUK" ? <Badge tone={res.by === "PETA" ? "green" : "blue"}>{res.by === "PETA" ? "dipetakan" : "otomatis"}</Badge> : <Badge tone="amber">Extra Packing</Badge>) : undefined} /></td>
                        <td className="whitespace-nowrap text-xs">{r.storeCodes.join(", ") || "-"}</td>
                        <td className="num">{r.orders}</td>
                        <td className="min-w-[16rem]">
                          {canManage ? <SkuRow mapped={!!res} skuKey={r.key} items={items} suggest={sugg} kind={res?.kind ?? "PRODUK"} itemId={res?.kind === "PRODUK" ? res.itemId : undefined} variant={res?.kind === "EXTRA_PACKING" ? res.variant : undefined} /> : <span className="text-xs text-slate-400">-</span>}
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
