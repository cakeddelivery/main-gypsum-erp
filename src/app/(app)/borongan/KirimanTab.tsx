import { prisma } from "@/lib/db";
import { fmtDay, dateOnly, todayStr } from "@/lib/time";
import { bomStockQty } from "@/lib/unitcost";
import { stockBalances } from "@/lib/stock";
import { canTask, type Scope } from "@/lib/borongan";
import { taskGroupName } from "@/lib/boronganKirim";
import { pointConfig, taskKits } from "@/lib/boronganSetup";
import { STATE_LABEL, byColumn, canCompleteAssembling, canDistribute, canInputKering, canPickup, canReceive, canReport, canShip, canShipGroup, isAssemblingName, openShipments, scopeShipments, shortTaskName, type ShipmentView } from "@/lib/boronganFlow";
import { Badge, Empty } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { AmbilForm, BagiForm, KeringForm, KirimForm, KoreksiForm, LaporForm, TerimaForm, type KirimGroupOpt } from "./KirimanForms";
import { ambilSetoran, batalAmbil, batalKiriman, isiPatungKering, kirimBahan, laporHasil, lengkapiKiriman, simpanPembagian, terimaSetoran, tindakTahanan } from "./kirimanActions";

const f = (n: number) => n.toLocaleString("id-ID");
const Chip = ({ children }: { children: React.ReactNode }) => <span className="inline-block break-all rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs font-semibold text-brand-700">{children}</span>;
const STATE_TONE = { DI_PEKERJA: "amber", SEBAGIAN: "amber", SELESAI: "green" } as const;

/** Kiriman yang relevan untuk akun ini */
function visible(scope: Scope, s: ShipmentView) {
  if (scope.all) return true;
  const asm = s.tasks.some((t) => isAssemblingName(t.name));
  // Tim Cetak/Oven & Packing: hanya kiriman Assembling (isian patung kering / penerimaan setoran)
  if (scope.kering || scope.packing) return asm;
  // Isian patung kering yang belum dilengkapi hanya untuk tim Assembling / Supervisor
  if (s.waitingSupport) return !!scope.warehouse || scope.division?.template === "ASSEMBLING";
  if (scope.driver) return s.mode === "DRIVER";
  if (scope.division) return !!scope.warehouse || s.tasks.some((t) => canTask(scope, t.id));
  return s.points.some((p) => scope.pointIds.includes(p.id));
}

/** Pilihan form Kirim Bahan: per kelompok jenis pekerjaan aktif → titik → bahan resep & bahan pendukung titik */
async function kirimGroups(): Promise<KirimGroupOpt[]> {
  const [tasks, points, cfg, balances] = await Promise.all([
    prisma.pieceTask.findMany({ where: { active: true }, include: { inputs: { include: { item: true } } }, orderBy: { name: "asc" } }),
    prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    pointConfig(prisma),
    stockBalances(prisma),
  ]);
  const pointLocs = new Set(points.map((p) => p.locationId));
  const stock = new Map<string, number>();
  for (const b of balances) if (!pointLocs.has(b.locationId)) stock.set(b.itemId, (stock.get(b.itemId) ?? 0) + b.qty);
  // Bahan pendukung mengikuti KIT per tugas (Tugas & Tarif), bukan gabungan paket bahan titik
  const kits = await taskKits(prisma);
  const kitIds = [...new Set(Object.values(kits).flat())];
  const kitItems = await prisma.item.findMany({ where: { id: { in: kitIds }, active: true }, select: { id: true, name: true, unit: true } });
  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) groups.set(taskGroupName(t.name), [...(groups.get(taskGroupName(t.name)) ?? []), t]);
  const out: KirimGroupOpt[] = [];
  for (const [name, ts] of groups) {
    const ids = ts.map((t) => t.id);
    const pts = points.filter((p) => !cfg[p.id]?.tasks.length || cfg[p.id].tasks.some((id) => ids.includes(id)));
    if (!pts.length) continue;
    const bomIds = new Set(ts.flatMap((t) => t.inputs.map((i) => i.itemId)));
    const support = [...new Set(ts.flatMap((t) => kits[t.id] ?? []))].filter((id) => !bomIds.has(id)).map((id) => kitItems.find((i) => i.id === id)).filter((i): i is (typeof kitItems)[number] => !!i);
    out.push({
      key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name,
      tasks: byColumn(ts, (t) => t.name).map((t) => ({ id: t.id, short: shortTaskName(t.name), bom: t.inputs.map((i) => ({ itemId: i.itemId, name: i.item.name, unit: i.item.unit, per: bomStockQty(i.qty, i.item) })) })),
      points: pts.map((p) => ({ id: p.id, name: p.name, viaDriver: p.viaDriver })),
      support: support.map((i) => ({ id: i.id, name: i.name, unit: i.unit, stock: Math.round((stock.get(i.id) ?? 0) * 1000) / 1000 })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

export async function KirimanTab({ scope, userId }: { scope: Scope; userId: string }) {
  // Koordinator: hanya bagian titiknya, dan baru tampil setelah bahan dibagi ke pekerja di titik itu (disaring di server)
  const all = scopeShipments(scope, (await openShipments()).filter((s) => visible(scope, s)));
  const complete = canCompleteAssembling(scope);
  const kering = canInputKering(scope);
  const ship = canShip(scope) || complete || kering;
  const [allGroups, drivers, workers] = await Promise.all([
    ship ? kirimGroups() : Promise.resolve([]),
    ship ? prisma.boronganPerson.findMany({ where: { role: "DRIVER", active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.boronganPerson.findMany({ where: { role: "PEKERJA", active: true, pointId: { in: [...new Set(all.flatMap((s) => s.points.map((p) => p.id)))] } }, orderBy: { name: "asc" }, select: { id: true, name: true, pointId: true, taskIds: true } }),
  ]);
  // Kirim langsung: Cat Plastik (tim Assembling), Cat Giftbox (tim Giftbox); Assembling lewat isian patung kering
  const groups = allGroups.filter((g) => canShipGroup(scope, g.name));
  const asmGroup = allGroups.find((g) => isAssemblingName(g.name));
  const waiting = all.filter((s) => s.waitingSupport);
  const creators = new Map((await prisma.boronganPickup.findMany({ where: { id: { in: all.flatMap((s) => s.pickups.map((p) => p.id)) } }, select: { id: true, createdById: true } })).map((p) => [p.id, p.createdById]));
  const toReceive = all.flatMap((s) => s.pickups.filter((p) => p.status === "DIBAWA" && canReceive(scope, s.tasks.filter((t) => p.lines.some((l) => l.taskId === t.id)))).map((p) => ({ s, p })));
  const held = scope.all ? all.flatMap((s) => s.pickups.filter((p) => p.status === "KURANG").map((p) => ({ s, p }))) : [];
  const running = all.filter((s) => !s.waitingSupport && (s.state !== "SELESAI" || s.pickups.some((p) => p.status === "DIBAWA")));
  const draftCreators = new Map((await prisma.boronganShipment.findMany({ where: { id: { in: waiting.map((w) => w.id) } }, select: { id: true, createdById: true } })).map((x) => [x.id, x.createdById]));

  return (
    <div className="space-y-4">
      {(kering && asmGroup) || groups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {kering && asmGroup && (
            <Modal trigger="+ Patung Kering" title="Patung kering untuk Assembling" subtitle="Nomor kiriman dibuat otomatis" wide>
              <ModalForm action={isiPatungKering} className="space-y-3"><KeringForm tasks={asmGroup.tasks} today={todayStr()} /></ModalForm>
            </Modal>
          )}
          {groups.length > 0 && (
            <Modal trigger="+ Kirim Bahan" triggerClass={kering && asmGroup ? "btn-secondary" : "btn-primary"} title="Kirim bahan" subtitle="Nomor kiriman dibuat otomatis" wide>
              <ModalForm action={kirimBahan} className="space-y-3"><KirimForm groups={groups} drivers={drivers} today={todayStr()} /></ModalForm>
            </Modal>
          )}
          <p className="text-xs text-slate-500">{kering && !groups.length ? "Isi patung kering per jenis; tim Assembling melengkapi bahan pendukung lalu mengirim." : "Kiriman berikutnya: pembagian ke pekerja → laporan hasil koordinator → ambil setoran → diterima divisi."}</p>
        </div>
      ) : null}

      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-amber-700">Menunggu bahan pendukung</h2>
          {waiting.map((s) => (
            <div key={s.id} className="card space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2"><Chip>{s.number}</Chip><span className="text-sm font-semibold text-slate-800">{fmtDay(dateOnly(s.date))}</span><span className="text-xs text-slate-500">patung kering dari {s.createdBy}</span></div>
              <div className="text-sm text-slate-700">{s.tasks.map((t) => `${t.short} ${f(t.qty)}`).join(" · ")} · <b>{f(s.totals.sent)} pcs</b></div>
              <div className="flex flex-wrap gap-2">
                {complete && asmGroup && (
                  <Modal trigger="Lengkapi & kirim" triggerClass="btn-primary btn-sm" title="Lengkapi kiriman Assembling" subtitle={`${s.number} · bahan pendukung, titik & driver`} wide>
                    <ModalForm action={lengkapiKiriman} className="space-y-3"><KirimForm groups={[asmGroup]} drivers={drivers} today={todayStr()} fixed={{ shipmentId: s.id, groupKey: asmGroup.key, qty: Object.fromEntries(s.tasks.map((t) => [t.id, t.qty])) }} /></ModalForm>
                  </Modal>
                )}
                {(complete || draftCreators.get(s.id) === userId) && (
                  <ActionForm action={batalKiriman} confirm={`Batalkan isian patung kering ${s.number}?`}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm text-rose-600">Batalkan</button></ActionForm>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {toReceive.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Setoran menunggu dihitung</h2>
          {toReceive.map(({ s, p }) => (
            <div key={p.id} className="card flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Chip>{p.number}</Chip><span className="text-xs text-slate-500">dari {s.number}</span></div>
                <div className="mt-1 text-sm text-slate-700">{s.group} · {p.lines.reduce((a, l) => a + l.qty, 0).toLocaleString("id-ID")} pcs · {p.driver ?? "tanpa driver"} · {fmtDay(dateOnly(p.date))}</div>
              </div>
              <Modal trigger="Terima" triggerClass="btn-primary btn-sm" title="Penerimaan setoran" subtitle={`${p.number} · ${s.group}`} wide>
                <ModalForm action={terimaSetoran} className="space-y-3"><TerimaForm pickup={p} tasks={s.tasks} /></ModalForm>
              </Modal>
            </div>
          ))}
        </section>
      )}

      {held.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-rose-700">Upah ditahan (hitungan kurang)</h2>
          {held.map(({ s, p }) => (
            <div key={p.id} className="card flex flex-wrap items-center gap-2 border-rose-200 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Chip>{p.number}</Chip><span className="text-xs text-slate-500">dari {s.number}</span></div>
                <div className="mt-1 break-words text-sm text-rose-700">{p.holdNote}</div>
              </div>
              <Modal trigger="Cek / koreksi" triggerClass="btn-secondary btn-sm" title="Setoran kurang" subtitle={`${p.number} · ${s.group}`} wide>
                <ModalForm action={tindakTahanan} className="space-y-3"><KoreksiForm pickup={p} tasks={s.tasks} /></ModalForm>
              </Modal>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Kiriman berjalan</h2>
        {!running.length && <Empty title="Belum ada kiriman berjalan" hint={ship ? "Tekan + Kirim Bahan untuk mencatat kiriman baru." : undefined} />}
        {running.map((s) => {
          const ids = s.tasks.map((t) => t.id);
          const bagi = canDistribute(scope, { mode: s.mode, taskIds: ids });
          const ambil = canPickup(scope, { mode: s.mode, taskIds: ids }) && s.cells.some((c) => !c.done);
          const lapor = s.points.filter((p) => s.cells.some((c) => c.pointId === p.id) && canReport(scope, { taskIds: ids }, p.id, p.coordinator));
          const activePickups = s.pickups.filter((p) => p.status !== "DIBATALKAN");
          const allotted = s.totals.allotted;
          return (
            <article key={s.id} className="card space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip>{s.number}</Chip>
                <span className="text-sm font-semibold text-slate-800">{fmtDay(dateOnly(s.date))}</span>
                <span className="ml-auto"><Badge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Badge></span>
              </div>
              <div className="break-words text-sm text-slate-700">{s.group} · {s.points.map((p) => p.name).join(", ")} · {s.mode === "DRIVER" ? `lewat driver${s.driver ? ` (${s.driver})` : ""}` : "diantar langsung"}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm keep-cols sm:grid-cols-4">
                <span className="text-slate-500">Dikirim <b className="text-slate-900">{f(s.totals.sent)}</b></span>
                <span className="text-slate-500">Dibagi <b className={allotted < s.totals.sent ? "text-amber-700" : "text-slate-900"}>{f(allotted)}</b></span>
                <span className="text-slate-500">Diambil <b className="text-slate-900">{f(s.cells.reduce((a, c) => a + c.diambil, 0))}</b></span>
                <span className="text-slate-500">Reject <b className="text-slate-900">{f(s.totals.reject)}</b></span>
              </div>
              {allotted < s.totals.sent && <p className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">{allotted ? `Masih ${f(s.totals.sent - allotted)} pcs belum dibagi ke pekerja.` : "Belum dibagi ke pekerja."}</p>}
              {activePickups.length > 0 && (
                <ul className="space-y-1 text-xs text-slate-600">
                  {activePickups.map((p, i) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <Chip>{p.number}</Chip> ke-{i + 1} · {f(p.lines.reduce((a, l) => a + l.qty, 0))} pcs ·
                      {p.status === "DIBAWA" ? <span className="font-semibold text-amber-700">menunggu dihitung</span> : p.status === "KURANG" ? <span className="font-semibold text-rose-700">kurang, upah ditahan</span> : <span className="font-semibold text-emerald-700">diterima</span>}
                      {p.status === "DIBAWA" && (scope.all || creators.get(p.id) === userId) && (
                        <ActionForm action={batalAmbil} confirm={`Batalkan pengambilan ${p.number}?`}><input type="hidden" name="id" value={p.id} /><button className="text-xs font-semibold text-rose-600 underline">Batalkan</button></ActionForm>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {bagi && (
                  <Modal trigger={allotted ? "Ubah pembagian" : "Bagi ke pekerja"} triggerClass={allotted ? "btn-secondary btn-sm" : "btn-primary btn-sm"} title="Pembagian ke pekerja" subtitle={`${s.number} · ${s.group}`} wide>
                    <ModalForm action={simpanPembagian} className="space-y-3"><BagiForm view={s} workers={workers.filter((w) => s.points.some((p) => p.id === w.pointId)).map((w) => ({ ...w, pointId: w.pointId! }))} /></ModalForm>
                  </Modal>
                )}
                {lapor.map((p) => (
                  <Modal key={p.id} trigger={`Lapor hasil${s.points.length > 1 ? ` ${p.name}` : ""}`} triggerClass="btn-secondary btn-sm" title={`Lapor hasil · ${p.name}`} subtitle={s.number} wide>
                    <ModalForm action={laporHasil} className="space-y-3"><LaporForm view={s} pointId={p.id} /></ModalForm>
                  </Modal>
                ))}
                {ambil && (
                  <Modal trigger="Ambil setoran" triggerClass="btn-primary btn-sm" title="Ambil setoran" subtitle={`${s.number} · nomor AMB dibuat otomatis`} wide>
                    <ModalForm action={ambilSetoran} className="space-y-3"><AmbilForm view={s} /></ModalForm>
                  </Modal>
                )}
                {canShip(scope) && !scope.kering && !scope.packing && !activePickups.length && (
                  <ActionForm action={batalKiriman} confirm={`Batalkan kiriman ${s.number}? Bahan kembali ke gudang.`}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm text-rose-600">Batalkan</button></ActionForm>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
