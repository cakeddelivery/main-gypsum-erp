import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { itemCosts, productCosting } from "@/lib/hpp";
import { CHANNEL_LABEL } from "@/lib/pricing";
import { productTypes } from "@/lib/productTypes";
import { PRICE_CHANNELS, familyInclude, familyMatrix } from "@/lib/productFamily";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { ProdukTabs } from "../../ProdukTabs";
import { CopyRecipeForm } from "./CopyRecipeForm";
import { createMissingSkus, saveFamilyPrices, saveVariantOption } from "../actions";

export const metadata = { title: "Produk Induk" };

const VARIANTS = ["COWOK", "CEWEK", "HEWAN", "TRANSPORTASI", "MIX"];

export default async function IndukDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePerm("product.view");
  const { id } = await params;
  const f = await prisma.productFamily.findUnique({ where: { id }, include: familyInclude });
  if (!f) notFound();
  const manage = user.can("product.manage");
  const canHpp = manage || user.can("accounting.view") || user.role === "OWNER";
  const matrix = familyMatrix(f);
  const ids = f.products.map((p) => p.id);
  const [bom, hist, types, costs] = await Promise.all([
    prisma.bomLine.groupBy({ by: ["productId"], where: { productId: { in: ids } }, _count: true }),
    prisma.priceHistory.findMany({ where: { productId: { in: ids } }, orderBy: { effectiveAt: "desc" } }),
    productTypes(prisma, { includeInactive: true }),
    itemCosts(),
  ]);
  const price = new Map<string, number>();
  for (const h of hist) if (!price.has(`${h.productId}.${h.channel}`)) price.set(`${h.productId}.${h.channel}`, Number(h.price));
  const recipe = new Map(bom.map((b) => [b.productId, b._count]));
  const hpp = new Map<string, number>();
  if (canHpp) for (const p of f.products) hpp.set(p.id, (await productCosting(p.id, costs)).hpp);
  const missing = matrix.filter((m) => !m.product).length;
  const label = (opts: { name: string }[]) => opts.map((o) => o.name).join(" · ");
  const made = matrix.filter((m) => m.product);
  const group = (opts: { name: string }[]) => opts.slice(0, -1).map((o) => o.name).join(" · ");

  const optionForm = (axisId: string, o?: (typeof f.axes)[number]["options"][number]) => (
    <ModalForm action={saveVariantOption} className="space-y-3">
      <input type="hidden" name="axisId" value={axisId} />
      {o && <input type="hidden" name="id" value={o.id} />}
      <Field label="Nama pilihan"><input name="name" defaultValue={o?.name} className="input" required /></Field>
      <Field label="Jumlah patung per SKU (opsional)" hint={`Kosong = ikut induk (${f.patungQty} patung)`}><input name="patungQty" defaultValue={o?.patungQty ?? ""} inputMode="numeric" className="input" /></Field>
      <Field label="Karakter patung (opsional)" hint="Untuk Series: patung kering yang dipakai">
        <select name="variant" defaultValue={o?.variant ?? ""} className="input"><option value="">—</option>{VARIANTS.map((v) => <option key={v} value={v}>{v}</option>)}</select>
      </Field>
      <Field label="Tipe produk SKU (opsional)">
        <select name="productType" defaultValue={o?.productType ?? ""} className="input"><option value="">— ikut induk —</option>{types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select>
      </Field>
      {o && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={o.active} /> Aktif</label>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={f.name}
        subtitle={`${f.code} · ${f.axes.map((a) => a.name).join(" × ")} · ${made.length} SKU${f.note ? ` · ${f.note}` : ""}`}
        actions={manage && (
          <>
            {missing > 0 && <ActionForm action={createMissingSkus}><input type="hidden" name="familyId" value={f.id} /><Submit pendingText="Membuat…">Buat {missing} SKU yang belum ada</Submit></ActionForm>}
            <Modal trigger="Isi harga massal" triggerClass="btn-primary" title={`Harga ${f.name}`} wide>
              <ModalForm action={saveFamilyPrices} className="space-y-3">
                <input type="hidden" name="familyId" value={f.id} />
                <p className="text-xs text-slate-500">Isi harga jual per SKU (Rp, tanpa titik juga boleh). Kosong = tidak diubah. Hanya harga yang berubah yang dicatat sebagai harga baru.</p>
                <div className="table-wrap max-h-[60vh] overflow-y-auto">
                  <table className="tbl">
                    <thead><tr><th>SKU</th>{canHpp && <th className="num">HPP</th>}{PRICE_CHANNELS.map((c) => <th key={c}>{CHANNEL_LABEL[c]}</th>)}</tr></thead>
                    <tbody>
                      {made.map(({ opts, product: p }) => (
                        <tr key={p!.id}>
                          <td className="text-sm">{label(opts)}<div className="font-mono text-xs text-slate-400">{p!.sku}</div></td>
                          {canHpp && <td className="num text-xs">{idr(hpp.get(p!.id) ?? 0)}</td>}
                          {PRICE_CHANNELS.map((c) => <td key={c}><input name={`price.${p!.id}.${c}`} defaultValue={price.get(`${p!.id}.${c}`) ?? ""} inputMode="numeric" placeholder="Rp" className="input min-w-24 py-1.5" /></td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Submit>Simpan harga</Submit>
              </ModalForm>
            </Modal>
            <Modal trigger="Salin resep" triggerClass="btn-secondary" title="Salin resep ke varian lain" wide>
              <CopyRecipeForm skus={made.map(({ opts, product: p }) => ({ id: p!.id, label: label(opts), hasRecipe: recipe.has(p!.id), group: group(opts) }))} />
            </Modal>
          </>
        )}
      />
      <ProdukTabs current="induk" />

      <Card title="Kategori varian">
        <div className="grid gap-4 md:grid-cols-3">
          {f.axes.map((a) => (
            <div key={a.id}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold">{a.name}</span>
                {manage && <Modal trigger="+ Pilihan" triggerClass="btn-secondary btn-sm" title={`Tambah pilihan ${a.name}`}>{optionForm(a.id)}</Modal>}
              </div>
              <ul className="divide-y divide-slate-100 text-sm">
                {a.options.map((o) => (
                  <li key={o.id} className={`flex items-center justify-between gap-2 py-1.5 ${o.active ? "" : "opacity-50"}`}>
                    <span>{o.name}{o.patungQty ? <span className="text-xs text-slate-500"> · {o.patungQty} patung</span> : null}{o.variant ? <span className="text-xs text-slate-500"> · {o.variant}</span> : null}{!o.active && <Badge>nonaktif</Badge>}</span>
                    {manage && <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah pilihan ${a.name}`}>{optionForm(a.id, o)}</Modal>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card title={`SKU (${made.length}${missing ? ` · ${missing} kombinasi belum dibuat` : ""})`}>
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Varian</th><th>SKU</th><th className="num">Patung</th><th>Resep</th>{canHpp && <th className="num">HPP</th>}{PRICE_CHANNELS.map((c) => <th key={c} className="num">{CHANNEL_LABEL[c]}</th>)}<th /></tr></thead>
            <tbody>
              {matrix.map(({ opts, product: p }) => p ? (
                <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                  <td>{label(opts)}</td>
                  <td className="font-mono text-xs">{p.sku}</td>
                  <td className="num">{p.packQty}</td>
                  <td>{recipe.has(p.id) ? <Badge tone="green">{recipe.get(p.id)} bahan</Badge> : <Badge tone="amber">belum</Badge>}</td>
                  {canHpp && <td className="num">{idr(hpp.get(p.id) ?? 0)}</td>}
                  {PRICE_CHANNELS.map((c) => <td key={c} className="num">{price.has(`${p.id}.${c}`) ? idr(price.get(`${p.id}.${c}`)!) : "-"}</td>)}
                  <td><Link href={`/produk/${p.id}`} className="btn-secondary btn-sm">Detail</Link></td>
                </tr>
              ) : (
                <tr key={opts.map((o) => o.id).join("|")} className="text-slate-400">
                  <td>{label(opts)}</td><td colSpan={canHpp ? 7 : 6} className="text-xs">belum dibuat</td><td />
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      </Card>
    </div>
  );
}
