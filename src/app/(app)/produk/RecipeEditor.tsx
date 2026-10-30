"use client";
import { useState } from "react";
import { toRecipeQty, useUnitOptions } from "@/lib/itemCatalog";
import { CHANNEL_LABEL, channelParams, suggestPrice, type FeeConfig } from "@/lib/pricing";

export type RecipeComponent = { id: string; name: string; unit: string; price: number; source: "BB" | "BSJ"; packaging: boolean };
export type RecipeTask = { id: string; name: string; rate: number };
export type RecipeOverheadOpt = { id: string; name: string; perPcs: number };
export type RecipeInitial = {
  comp: { itemId: string; qty: number; useUnit: string }[];
  labor: { taskId: string; name: string; rate: number }[];
  oh: { overheadId: string; factor: number }[];
  extraPackaging?: number;
  targetMargin?: number;
};

export const MARGIN_OPTIONS = [
  { value: 20, label: "20% (Tipis)" },
  { value: 30, label: "30% (Standar)" },
  { value: 40, label: "40% (Bagus)" },
  { value: 50, label: "50% (Ideal Mainan)" },
  { value: 60, label: "60% (Premium)" },
];

const rp = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;
const num = (v: string) => Number(v.replace(/\./g, "").replace(",", ".")) || 0;
const dec = (v: string) => Number(v.replace(",", ".")) || 0;
let seq = 0;
const key = () => ++seq;

type CompRow = { k: number; source: "BB" | "BSJ"; itemId: string; qty: string; useUnit: string };
type LaborRow = { k: number; taskId: string; name: string; custom: string };
type OhRow = { k: number; overheadId: string; factor: string };

function Section({ title, tone, add, onAdd, children }: { title: string; tone: string; add: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <section className={`rounded-2xl border p-3 ${tone}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold">{title}</p>
        <button type="button" className="btn-secondary btn-sm shrink-0" onClick={onAdd}>+ {add}</button>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const Del = ({ onClick }: { onClick: () => void }) => <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm" onClick={onClick}>×</button>;

/**
 * Penyusun resep HPP: komponen (bahan baku / setengah jadi) dengan satuan pakai, tenaga kerja borongan,
 * overhead, dan (untuk produk) packaging + target margin + saran harga. Semua dihitung langsung di layar.
 */
export function RecipeEditor({ components, tasks, overheads, initial, product }: {
  components: RecipeComponent[];
  tasks: RecipeTask[];
  overheads: RecipeOverheadOpt[];
  initial?: RecipeInitial;
  product?: { fees: FeeConfig; affiliatePct: number; adsPct: number; itemsPerOrder: number; legacy?: number };
}) {
  const byId = new Map(components.map((c) => [c.id, c]));
  const isPack = (id: string) => !!product && !!byId.get(id)?.packaging;
  const toRow = (c: RecipeInitial["comp"][number]): CompRow => ({ k: key(), source: byId.get(c.itemId)?.source ?? "BB", itemId: c.itemId, qty: String(c.qty), useUnit: c.useUnit });
  const init = initial?.comp ?? [];
  const [comp, setComp] = useState<CompRow[]>(() => init.filter((c) => !isPack(c.itemId)).map(toRow));
  const [pack, setPack] = useState<CompRow[]>(() => init.filter((c) => isPack(c.itemId)).map(toRow));
  const [labor, setLabor] = useState<LaborRow[]>(() => (initial?.labor ?? []).map((l) => {
    const t = tasks.find((x) => x.id === l.taskId);
    return { k: key(), taskId: l.taskId || "", name: l.name, custom: t && t.rate === l.rate ? "" : String(l.rate) };
  }));
  const [oh, setOh] = useState<OhRow[]>(() => (initial?.oh ?? []).map((o) => ({ k: key(), overheadId: o.overheadId, factor: String(o.factor) })));
  const [extra, setExtra] = useState(initial?.extraPackaging ? String(initial.extraPackaging) : "");
  const [target, setTarget] = useState(String(initial?.targetMargin ?? 50));

  const lineCost = (r: CompRow) => {
    const c = byId.get(r.itemId);
    return c ? c.price * toRecipeQty(dec(r.qty), r.useUnit, c.unit) : 0;
  };
  const laborRate = (r: LaborRow) => (r.custom.trim() ? num(r.custom) : tasks.find((t) => t.id === r.taskId)?.rate ?? 0);
  const ohCost = (r: OhRow) => (overheads.find((o) => o.id === r.overheadId)?.perPcs ?? 0) * dec(r.factor);
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  const material = sum(comp, lineCost);
  const packaging = sum(pack, lineCost) + num(extra);
  const laborTotal = sum(labor, laborRate);
  const ohTotal = sum(oh, ohCost);
  const hpp = Math.round(material + packaging + laborTotal + ohTotal + (product?.legacy ?? 0));

  const compRows = (rows: CompRow[], set: React.Dispatch<React.SetStateAction<CompRow[]>>, packaging: boolean) => {
    const patch = (i: number, p: Partial<CompRow>) => set((x) => x.map((y, j) => (j === i ? { ...y, ...p } : y)));
    return (
      <table className="tbl min-w-[620px]">
        <thead><tr>{!packaging && <th>Sumber</th>}<th>{packaging ? "Item Packaging / Kemasan" : "Nama Komponen"}</th><th className="num">Harga Master</th><th>Satuan Pakai</th><th className="num">Penggunaan</th><th className="num">Subtotal</th><th /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="text-center text-xs text-slate-400">Belum ada baris</td></tr>}
          {rows.map((r, i) => {
            const c = byId.get(r.itemId);
            const opts = components.filter((x) => (packaging ? x.packaging : !isPack(x.id) && x.source === r.source));
            const units = c ? useUnitOptions(c.unit) : [];
            return (
              <tr key={r.k}>
                {!packaging && <td className="w-36"><select value={r.source} className="input" onChange={(e) => patch(i, { source: e.target.value as CompRow["source"], itemId: "", useUnit: "" })}><option value="BB">Bahan Baku</option><option value="BSJ">Setengah Jadi</option></select></td>}
                <td className="min-w-44">
                  <select name="comp_item" value={r.itemId} className="input" required onChange={(e) => { const n = byId.get(e.target.value); patch(i, { itemId: e.target.value, useUnit: n ? useUnitOptions(n.unit)[0] : "" }); }}>
                    <option value="" disabled>— pilih —</option>
                    {opts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </td>
                <td className="num whitespace-nowrap">{c ? `${rp(c.price * toRecipeQty(1, r.useUnit || c.unit, c.unit))}/${r.useUnit || c.unit}` : "Rp 0"}</td>
                <td className="w-32">{units.length > 1 ? <select name="comp_unit" value={r.useUnit} className="input" onChange={(e) => patch(i, { useUnit: e.target.value })}>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select> : <><input type="hidden" name="comp_unit" value={r.useUnit || c?.unit || ""} /><span className="text-sm">{c?.unit ?? "-"}</span></>}</td>
                <td className="w-28"><input name="comp_qty" value={r.qty} inputMode="decimal" placeholder="0" className="input text-right" onChange={(e) => patch(i, { qty: e.target.value })} /></td>
                <td className="num whitespace-nowrap">{rp(lineCost(r))}</td>
                <td><Del onClick={() => set((x) => x.filter((_, j) => j !== i))} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };
  const addComp = (set: React.Dispatch<React.SetStateAction<CompRow[]>>) => set((x) => [...x, { k: key(), source: "BB", itemId: "", qty: "", useUnit: "" }]);
  const Total = ({ label, value }: { label: string; value: number }) => <p className="mt-2 flex justify-end gap-3 text-sm font-semibold">{label} <span className="tabular-nums">{rp(value)}</span></p>;

  const suggestions = product
    ? (["OFFLINE", "SHOPEE", "TIKTOK_SHOP"] as const).map((ch) => {
        const params = channelParams(ch, hpp, product.fees, product);
        return { ch, price: suggestPrice({ ...params, marginPct: Number(target) }) };
      })
    : [];

  return (
    <div className="space-y-3">
      <Section title={product ? "Section 1: Biaya Bahan Baku & Setengah Jadi" : "Komponen Penyusun (Bahan Baku / Setengah Jadi Lain)"} tone="border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" add="Komponen" onAdd={() => addComp(setComp)}>
        {compRows(comp, setComp, false)}
        <Total label="Total Biaya Bahan:" value={material} />
      </Section>

      <Section title={product ? "Section 2: Biaya Tenaga Kerja Borongan" : "Biaya Tenaga Kerja Borongan (Opsional)"} tone="border-indigo-200 bg-indigo-50/40 dark:border-indigo-900 dark:bg-indigo-950/20" add="Tenaga Kerja" onAdd={() => setLabor((x) => [...x, { k: key(), taskId: "", name: "", custom: "" }])}>
        <table className="tbl min-w-[560px]">
          <thead><tr><th>Pekerja / Spesialisasi Borongan</th><th className="num">Tarif Master / Pcs</th><th>Tarif Custom / Pcs</th><th className="num">Subtotal</th><th /></tr></thead>
          <tbody>
            {labor.length === 0 && <tr><td colSpan={5} className="text-center text-xs text-slate-400">Belum ada baris</td></tr>}
            {labor.map((r, i) => {
              const t = tasks.find((x) => x.id === r.taskId);
              const patch = (p: Partial<LaborRow>) => setLabor((x) => x.map((y, j) => (j === i ? { ...y, ...p } : y)));
              return (
                <tr key={r.k}>
                  <td className="min-w-48">
                    <select name="labor_task" value={r.taskId} className="input" onChange={(e) => patch({ taskId: e.target.value, name: tasks.find((x) => x.id === e.target.value)?.name ?? r.name })}>
                      <option value="">Lainnya (tulis sendiri)</option>
                      {tasks.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    {!r.taskId ? <input name="labor_name" value={r.name} placeholder="Nama pekerjaan" className="input mt-1" required onChange={(e) => patch({ name: e.target.value })} /> : <input type="hidden" name="labor_name" value={t?.name ?? r.name} />}
                  </td>
                  <td className="num whitespace-nowrap">{rp(t?.rate ?? 0)}</td>
                  <td className="w-36"><input name="labor_rate" value={r.custom} inputMode="numeric" placeholder={t ? "kosong = master" : "Cth: 1500"} className="input text-right" onChange={(e) => patch({ custom: e.target.value })} /></td>
                  <td className="num whitespace-nowrap">{rp(laborRate(r))}</td>
                  <td><Del onClick={() => setLabor((x) => x.filter((_, j) => j !== i))} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Total label="Total Biaya Tenaga Kerja:" value={laborTotal} />
      </Section>

      <Section title={product ? "Section 3: Overhead Produksi (Listrik, Air, Gas, Sewa, Oven, dll)" : "Overhead Produksi (Opsional)"} tone="border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20" add="Overhead" onAdd={() => setOh((x) => [...x, { k: key(), overheadId: "", factor: "1" }])}>
        <table className="tbl min-w-[520px]">
          <thead><tr><th>Komponen Overhead Master</th><th className="num">Biaya Master / Pcs</th><th>Faktor / Pcs</th><th className="num">Subtotal</th><th /></tr></thead>
          <tbody>
            {oh.length === 0 && <tr><td colSpan={5} className="text-center text-xs text-slate-400">{overheads.length ? "Belum ada baris" : "Belum ada overhead master. Isi dulu di tab Overhead."}</td></tr>}
            {oh.map((r, i) => {
              const o = overheads.find((x) => x.id === r.overheadId);
              const patch = (p: Partial<OhRow>) => setOh((x) => x.map((y, j) => (j === i ? { ...y, ...p } : y)));
              return (
                <tr key={r.k}>
                  <td className="min-w-48"><select name="oh_id" value={r.overheadId} className="input" required onChange={(e) => patch({ overheadId: e.target.value })}><option value="" disabled>— pilih —</option>{overheads.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
                  <td className="num whitespace-nowrap">{rp(o?.perPcs ?? 0)}</td>
                  <td className="w-28"><input name="oh_factor" value={r.factor} inputMode="decimal" className="input text-right" onChange={(e) => patch({ factor: e.target.value })} /></td>
                  <td className="num whitespace-nowrap">{rp(ohCost(r))}</td>
                  <td><Del onClick={() => setOh((x) => x.filter((_, j) => j !== i))} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Total label="Total Overhead Produksi:" value={ohTotal} />
      </Section>

      {product && (
        <Section title="Section 4: Biaya Packaging & Kemasan" tone="border-fuchsia-200 bg-fuchsia-50/40 dark:border-fuchsia-900 dark:bg-fuchsia-950/20" add="Packaging" onAdd={() => addComp(setPack)}>
          {compRows(pack, setPack, true)}
          <label className="mt-3 block"><span className="label">Tambahan Biaya Kemasan Lainnya / Pcs (Opsional, Rp)</span><input name="extraPackaging" value={extra} inputMode="numeric" placeholder="Cth: 200" className="input" onChange={(e) => setExtra(e.target.value)} /></label>
          <Total label="Total Biaya Packaging:" value={packaging} />
        </Section>
      )}

      {product && (
        <label className="block"><span className="label">Target Margin Keuntungan Usaha</span>
          <select name="targetMargin" value={target} className="input" onChange={(e) => setTarget(e.target.value)}>
            {[...MARGIN_OPTIONS, ...(MARGIN_OPTIONS.some((m) => String(m.value) === target) ? [] : [{ value: Number(target), label: `${target}%` }])].map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      )}

      <div className="rounded-2xl bg-indigo-950 p-4 text-white">
        <p className="flex justify-between text-sm">Total HPP Modal / Pcs: <b className="text-xl">{rp(hpp)}</b></p>
        {product?.legacy ? <p className="mt-1 text-xs text-indigo-200">Termasuk biaya manual lama {rp(product.legacy)} yang akan dihapus saat resep disimpan.</p> : null}
        {suggestions.map((s) => (
          <p key={s.ch} className="mt-1 flex justify-between text-sm"><span>Saran Harga {s.ch === "OFFLINE" ? "Direct (Toko Offline)" : CHANNEL_LABEL[s.ch]}:</span><b className="text-amber-300">{s.price ? rp(s.price) : "tidak tercapai"}</b></p>
        ))}
        {product && <p className="mt-2 text-xs text-indigo-200">Saran marketplace sudah memperhitungkan potongan admin, biaya pesanan, affiliate & iklan produk ini.</p>}
      </div>
    </div>
  );
}
