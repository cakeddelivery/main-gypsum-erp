import { prisma } from "@/lib/db";
import type { Scope } from "@/lib/borongan";
import { isCoordinatorScope } from "@/lib/boronganFlow";
import { pointStock } from "@/lib/boronganPointStock";
import { Badge, Empty, Field } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { koreksiStokTitik, mintaBahan } from "./stokActions";

const f = (n: number) => Number(n.toFixed(3)).toLocaleString("id-ID");

/**
 * Stok bahan pendukung di titik (portal koordinator): stok di titik, masuk & terpakai minggu ini,
 * peringatan stok tipis + "Minta bahan", dan koreksi/opname dengan alasan. Koordinator hanya titiknya sendiri.
 */
export async function StokTitikTab({ scope }: { scope: Scope }) {
  const where = scope.all ? { active: true } : isCoordinatorScope(scope) ? { active: true, id: { in: scope.pointIds } } : { id: "-" };
  const points = await prisma.boronganPoint.findMany({ where, orderBy: { code: "asc" }, select: { id: true, name: true } });
  if (!points.length) return <Empty title="Belum ada titik" />;
  const data = await Promise.all(points.map(async (p) => ({ point: p, rows: await pointStock(p.id) })));
  return (
    <div className="space-y-6">
      {data.map(({ point, rows }) => {
        const low = rows.filter((r) => r.low);
        return (
          <section key={point.id} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Stok bahan · {point.name}</h2>
              <div className="flex gap-2">
                <Modal trigger="Minta bahan" triggerClass={low.length ? "btn-primary btn-sm" : "btn-secondary btn-sm"} title={`Minta bahan · ${point.name}`}>
                  <ModalForm action={mintaBahan} className="space-y-3">
                    <input type="hidden" name="pointId" value={point.id} />
                    <p className="text-sm text-slate-600">Centang bahan yang perlu dikirim. Supervisor & tim Assembling mendapat notifikasi di HP.</p>
                    <div className="max-h-72 space-y-1 overflow-y-auto">
                      {rows.map((r) => (
                        <label key={r.itemId} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm hover:bg-slate-50">
                          <input type="checkbox" name="itemId" value={r.itemId} defaultChecked={r.low} className="h-4 w-4" />
                          <span className="min-w-0 flex-1">{r.name}</span>
                          <span className={`shrink-0 tabular-nums ${r.low ? "font-semibold text-rose-700" : "text-slate-500"}`}>{f(r.stock)} {r.unit}</span>
                        </label>
                      ))}
                    </div>
                    <Field label="Catatan (opsional)"><input name="note" className="input" placeholder="mis. untuk setoran Kamis" /></Field>
                    <Submit>Kirim permintaan</Submit>
                  </ModalForm>
                </Modal>
                <Modal trigger="Koreksi stok" triggerClass="btn-secondary btn-sm" title={`Koreksi stok · ${point.name}`}>
                  <ModalForm action={koreksiStokTitik} className="space-y-3">
                    <input type="hidden" name="pointId" value={point.id} />
                    <Field label="Bahan">
                      <select name="itemId" className="input" required defaultValue="">
                        <option value="" disabled>— pilih bahan —</option>
                        {rows.map((r) => <option key={r.itemId} value={r.itemId}>{r.name} (sistem {f(r.stock)} {r.unit})</option>)}
                      </select>
                    </Field>
                    <Field label="Jumlah fisik sekarang"><input name="counted" inputMode="decimal" className="input" required placeholder="0" /></Field>
                    <Field label="Alasan"><input name="reason" className="input" required minLength={3} placeholder="mis. hitung ulang, rusak, hilang" /></Field>
                    <p className="text-xs text-slate-500">Stok sistem disamakan dengan jumlah fisik. Tercatat di mutasi stok & riwayat aktivitas.</p>
                    <Submit>Simpan koreksi</Submit>
                  </ModalForm>
                </Modal>
              </div>
            </div>
            {low.length > 0 && (
              <div role="status" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                ⚠ {low.length} bahan menipis: {low.slice(0, 3).map((r) => r.name).join(", ")}{low.length > 3 ? `, +${low.length - 3} lainnya` : ""}. Tekan <b>Minta bahan</b>.
              </div>
            )}
            {!rows.length ? (
              <Empty title="Belum ada bahan di titik ini" />
            ) : (
              <div className="table-wrap">
                <Paged>
                  <table className="tbl">
                    <thead><tr><th>Bahan</th><th className="num">Stok</th><th className="num">Masuk</th><th className="num">Pakai</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.itemId}>
                          <td className="!whitespace-normal">{r.name}{r.low && <> <Badge tone="red">tipis</Badge></>}</td>
                          <td className={`num font-semibold ${r.stock < 0 ? "text-rose-700" : ""}`}>{f(r.stock)} <span className="text-xs font-normal text-slate-400">{r.unit}</span></td>
                          <td className="num">{f(r.inWeek)}</td>
                          <td className="num">{f(r.usedWeek)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Paged>
              </div>
            )}
            <p className="text-xs text-slate-500">Masuk = kiriman/pembagian ke titik minggu ini · Pakai = otomatis dari setoran × resep minggu ini.</p>
          </section>
        );
      })}
    </div>
  );
}
