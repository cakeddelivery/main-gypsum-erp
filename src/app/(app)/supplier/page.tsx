import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { supplierDebt } from "@/lib/suppliers";
import { Field } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { PartnerList } from "./PartnerList";
import { deleteSupplier, mergeSupplier, saveSupplier } from "./actions";

export const metadata = { title: "Supplier" };

export default async function SupplierPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePerm("partner.view");
  const { q } = await searchParams;
  const [rows, all, debt] = await Promise.all([
    prisma.supplier.findMany({
      where: q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { aliases: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { address: { contains: q, mode: "insensitive" } }] } : {},
      include: { _count: { select: { items: true, purchases: true, payables: true } } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    supplierDebt(),
  ]);
  const canManage = user.can("partner.manage");
  return (
    <PartnerList
      kind="Supplier"
      subtitle="Pemasok bahan baku. Klik nama supplier untuk melihat hutang, pembelian & riwayat pembayarannya."
      q={q}
      canManage={canManage}
      save={saveSupplier}
      remove={deleteSupplier}
      extraHeader="Hutang · dipakai"
      rows={rows.map((s) => {
        const d = debt.get(s.id);
        const rem = d ? d.amount - d.paid : 0;
        return {
          ...s,
          href: `/supplier/${s.id}`,
          extra: (
            <span className="text-xs">
              {rem > 0 ? <b className="text-amber-700">Sisa hutang {idr(rem)}</b> : d ? <span className="text-emerald-700">Hutang lunas</span> : <span className="text-slate-400">Tanpa hutang</span>}
              <br />
              {s._count.items} item · {s._count.purchases} pembelian · {s._count.payables} hutang
            </span>
          ),
          actions: canManage && all.length > 1 && (
            <Modal trigger="Gabungkan" triggerClass="btn-secondary btn-sm" title={`Gabungkan ${s.name}`}>
              <ModalForm action={mergeSupplier} className="space-y-3">
                <input type="hidden" name="sourceId" value={s.id} />
                <p className="text-sm text-slate-600">Untuk supplier dobel (orangnya sama, namanya beda). Semua hutang, pembelian, dan item <b>{s.name}</b> dipindah ke supplier tujuan, lalu {s.name} dihapus. Nama lamanya disimpan sebagai nama lain supaya tetap dikenali.</p>
                <Field label="Gabungkan ke supplier"><select name="targetId" className="input" required defaultValue=""><option value="" disabled>— pilih supplier —</option>{all.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
                <Field label="Nama yang dipakai (opsional)" hint="Kosongkan untuk memakai nama supplier tujuan"><input name="name" className="input" placeholder="nama supplier tujuan" /></Field>
                <Submit pendingText="Menggabungkan…">Gabungkan</Submit>
              </ModalForm>
            </Modal>
          ),
        };
      })}
    />
  );
}
