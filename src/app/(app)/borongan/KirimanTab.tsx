import Link from "next/link";
import { prisma } from "@/lib/db";
import { addDays, fmtDay, dateOnly, todayStr } from "@/lib/time";
import { Paged } from "@/components/Paged";
import { Tabs } from "@/components/ui";
import { bomStockQty } from "@/lib/unitcost";
import { stockBalances } from "@/lib/stock";
import { canTask, type Scope } from "@/lib/borongan";
import { taskGroupName } from "@/lib/boronganKirim";
import { pointConfig, taskKits } from "@/lib/boronganSetup";
import { STATE_LABEL, byColumn, canCompleteAssembling, canCancelShipment, canDistribute, fullAccess, canInputKering, canPickup, canReceive, canReport, canShip, canShipGroup, isAssemblingName, isCoordinatorScope, openShipments, scopeShipments, shipmentViews, shortTaskName, type ShipmentView } from "@/lib/boronganFlow";
import { Badge, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { AmbilForm, BagiForm, KeringForm, KirimForm, KoreksiForm, LaporForm, TerimaForm, TerimaJenisForm, UbahJumlahForm, type KirimGroupOpt } from "./KirimanForms";
import { ambilSetoran, batalAmbil, batalKiriman, isiPatungKering, kirimBahan, laporHasil, lengkapiKiriman, simpanPembagian, terimaHasilJenis, terimaSetoran, tindakTahanan, ubahJumlahKiriman } from "./kirimanActions";

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
    // Hasil diisi saat penerimaan (mis. Cat Plastik): tanpa jumlah pcs, jadi bahan resep juga diisi manual sebagai bahan kiriman
    const free = ts.every((t) => t.resultAtReceipt);
    const bomIds = new Set(ts.flatMap((t) => t.inputs.map((i) => i.itemId)));
    const bomItems = free ? ts.flatMap((t) => t.inputs.map((i) => ({ id: i.item.id, name: i.item.name, unit: i.item.unit }))) : [];
    const support = [...new Map([...bomItems, ...[...new Set(ts.flatMap((t) => kits[t.id] ?? []))].filter((id) => free || !bomIds.has(id)).map((id) => kitItems.find((i) => i.id === id)).filter((i): i is (typeof kitItems)[number] => !!i)].map((i) => [i.id, i])).values()];
    // Saran jumlah bahan: kiriman terakhir ke titik yang sama untuk jenis pekerjaan ini
    const suggest: Record<string, { number: string; qty: Record<string, number> }> = {};
    if (free) {
      for (const p of pts) {
        const last = await prisma.boronganShipment.findFirst({ where: { cancelledAt: null, pointIds: { has: p.id }, tasks: { some: { taskId: { in: ids } } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], select: { number: true, lines: { select: { itemId: true, qty: true } } } });
        if (last) suggest[p.id] = { number: last.number, qty: Object.fromEntries(last.lines.map((l) => [l.itemId, Number(l.qty)])) };
      }
    }
    out.push({
      key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name,
      tasks: byColumn(ts, (t) => t.name).map((t) => ({ id: t.id, short: shortTaskName(t.name), resultAtReceipt: t.resultAtReceipt, bom: t.inputs.map((i) => ({ itemId: i.itemId, name: i.item.name, unit: i.item.unit, per: bomStockQty(i.qty, i.item) })) })),
      points: pts.map((p) => ({ id: p.id, name: p.name, viaDriver: p.viaDriver })),
      support: support.map((i) => ({ id: i.id, name: i.name, unit: i.unit, stock: Math.round((stock.get(i.id) ?? 0) * 1000) / 1000 })),
      ...(free ? { suggest } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

/** Supervisor/Owner mengerjakan atas nama peran aslinya: label (backup) + konfirmasi + catatan di modal */
const bk = (scope: Scope, who: string) => (scope.backup ? { label: " (backup)", confirm: `Anda mengerjakan atas nama ${who}. Lanjutkan?`, note: <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Mode backup: Anda mengerjakan atas nama <b>{who}</b>. Peran asli tidak berubah; tindakan tercatat atas nama Anda di riwayat aktivitas.</p> } : { label: "", confirm: undefined, note: null });

export async function KirimanTab({ scope, userId, filter }: { scope: Scope; userId: string; /** Filter tampilan (?f=): menunggu | setoran | ditahan | berjalan | riwayat */ filter?: string }) {
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
  const creators = new Map((await prisma.boronganPickup.findMany({ where: { id: { in: all.flatMap((s) => s.pickups.map((p) => p.id)) } }, select: { id: true, createdById: true, createdAt: true } })).map((p) => [p.id, { by: p.createdById, at: p.createdAt }]));
  const sameDay = (d?: Date) => !!d && todayStr(d) === todayStr();
  // Batalkan AMB: pencatatnya hanya yang miliknya & hari ini; Supervisor/Owner kapan saja (belum dihitung); sudah dihitung hanya Owner; koordinator tidak pernah
  const canCancelAmb = (id: string, status: string) => {
    if (isCoordinatorScope(scope) || status === "DIBATALKAN") return false;
    if (status !== "DIBAWA") return !!scope.owner;
    const c = creators.get(id);
    return fullAccess(scope) || (c?.by === userId && sameDay(c?.at));
  };
  const toReceive = all.flatMap((s) => s.pickups.filter((p) => p.status === "DIBAWA" && canReceive(scope, s.tasks.filter((t) => p.lines.some((l) => l.taskId === t.id)))).map((p) => ({ s, p })));
  // Hasil diisi saat penerimaan (mis. Cat Plastik): titik yang sudah dilapor koordinator tapi belum diterima divisi
  const notReceived = (s: ShipmentView, pointId: string) => (s.crosscheck ?? []).filter((c) => c.pointId === pointId).every((c) => c.received == null);
  // Urutan bebas: penerimaan boleh lebih dulu dari laporan koordinator
  const toCount = all.filter((s) => s.resultAtReceipt && canReceive(scope, s.tasks)).flatMap((s) => s.points.filter((p) => notReceived(s, p.id)).map((p) => ({ s, p })));
  // Koreksi / lepas tahanan: Owner (Supervisor hanya memantau)
  const held = scope.owner ? all.flatMap((s) => s.pickups.filter((p) => p.status === "KURANG").map((p) => ({ s, p }))) : [];
  const running = all.filter((s) => !s.waitingSupport && (s.state !== "SELESAI" || s.pickups.some((p) => p.status === "DIBAWA")));
  // Koordinator: riwayat kiriman yang sudah selesai (bagian titiknya saja)
  const coordinator = isCoordinatorScope(scope);
  const done = coordinator
    ? scopeShipments(scope, await shipmentViews({ cancelledAt: null, pointIds: { hasSome: scope.pointIds }, date: { gte: dateOnly(addDays(todayStr(), -180)) } }, 200)).filter((s) => !running.some((r) => r.id === s.id))
    : [];
  const shipCreators = new Map((await prisma.boronganShipment.findMany({ where: { id: { in: running.map((r) => r.id) } }, select: { id: true, createdById: true } })).map((x) => [x.id, x.createdById]));
  const draftCreators = new Map((await prisma.boronganShipment.findMany({ where: { id: { in: waiting.map((w) => w.id) } }, select: { id: true, createdById: true } })).map((x) => [x.id, x.createdById]));

  // Filter status: satu daftar per tab agar halaman tidak panjang (tab kosong disembunyikan, Berjalan selalu ada)
  const filters = [
    { key: "menunggu", label: "Menunggu bahan", count: waiting.length },
    { key: "setoran", label: "Setoran dihitung", count: toReceive.length + toCount.length },
    { key: "ditahan", label: "Upah ditahan", count: held.length },
    { key: "berjalan", label: "Berjalan", count: running.length },
    ...(coordinator ? [{ key: "riwayat", label: "Riwayat", count: done.length }] : []),
  ].filter((t) => t.count > 0 || t.key === "berjalan");
  const active = filters.some((t) => t.key === filter) ? filter! : (filters.find((t) => t.count > 0)?.key ?? "berjalan");

  return (
    <div className="space-y-4">
      {(kering && asmGroup) || groups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {kering && asmGroup && (
            <Modal trigger="+ Kirim Assembling" title="Kirim Assembling (patung kering)" subtitle="Nomor kiriman dibuat otomatis" wide>
              <ModalForm action={isiPatungKering} className="space-y-3"><KeringForm tasks={asmGroup.tasks} today={todayStr()} /></ModalForm>
            </Modal>
          )}
          {groups.length > 0 && (
            <Modal trigger="+ Kirim Cat" triggerClass={kering && asmGroup ? "btn-secondary" : "btn-primary"} title="Kirim Cat" subtitle="Nomor kiriman dibuat otomatis" wide>
              <ModalForm action={kirimBahan} className="space-y-3"><KirimForm groups={groups} drivers={drivers} today={todayStr()} /></ModalForm>
            </Modal>
          )}
          <p className="text-xs text-slate-500">{kering && !groups.length ? "Isi patung kering per jenis; tim Assembling melengkapi bahan pendukung lalu mengirim." : "Kiriman berikutnya: pembagian ke pekerja → laporan hasil koordinator → ambil setoran → diterima divisi."}</p>
        </div>
      ) : null}

      {filters.length > 1 && <Tabs current={active} tabs={filters.map((t) => ({ key: t.key, label: t.label, count: t.count, href: `/borongan?tab=kiriman&f=${t.key}` }))} />}

      {active === "menunggu" && waiting.length > 0 && (
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
                {canCancelShipment(scope, { waitingSupport: true, createdById: draftCreators.get(s.id) ?? null }, userId) && (
                  <ActionForm action={batalKiriman} confirm={`Batalkan isian patung kering ${s.number}?`}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm text-rose-600">Batalkan</button></ActionForm>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {active === "setoran" && toCount.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Hasil menunggu diterima (hitung per jenis)</h2>
          {toCount.map(({ s, p }) => (
            <div key={`${s.id}:${p.id}`} className="card flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Chip>{s.number}</Chip><span className="text-xs text-slate-500">{p.name}</span></div>
                <div className="mt-1 text-sm text-slate-700">{s.group} · {s.reports.some((r) => r.pointId === p.id) ? "laporan koordinator sudah masuk" : "laporan koordinator belum masuk (boleh diterima dulu)"} · {fmtDay(dateOnly(s.date))}</div>
              </div>
              <Modal trigger={`Terima hasil${bk(scope, "divisi penerima").label}`} triggerClass="btn-primary btn-sm" title="Penerimaan hasil per jenis" subtitle={`${s.number} · ${p.name}`} wide>
                <ModalForm action={terimaHasilJenis} className="space-y-3" confirm={bk(scope, "divisi penerima").confirm}>{bk(scope, "divisi penerima").note}<TerimaJenisForm view={s} pointId={p.id} /></ModalForm>
              </Modal>
            </div>
          ))}
        </section>
      )}

      {active === "setoran" && toReceive.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Setoran menunggu dihitung</h2>
          {toReceive.map(({ s, p }) => (
            <div key={p.id} className="card flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Chip>{p.number}</Chip><span className="text-xs text-slate-500">dari {s.number}</span></div>
                <div className="mt-1 text-sm text-slate-700">{s.group} · {p.lines.reduce((a, l) => a + l.qty, 0).toLocaleString("id-ID")} pcs · {p.driver ?? "tanpa driver"} · {fmtDay(dateOnly(p.date))}</div>
              </div>
              <Modal trigger={`Terima${bk(scope, "divisi penerima").label}`} triggerClass="btn-primary btn-sm" title="Penerimaan setoran" subtitle={`${p.number} · ${s.group}`} wide>
                <ModalForm action={terimaSetoran} className="space-y-3" confirm={bk(scope, "divisi penerima").confirm}>{bk(scope, "divisi penerima").note}<TerimaForm pickup={p} tasks={s.tasks} /></ModalForm>
              </Modal>
            </div>
          ))}
        </section>
      )}

      {active === "ditahan" && held.length > 0 && (
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

      {active === "berjalan" && (
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Kiriman berjalan</h2>
        {!running.length && <Empty title="Belum ada kiriman berjalan" hint={ship ? "Tekan + Kirim Assembling / + Kirim Cat untuk mencatat kiriman baru." : undefined} />}
        {running.map((s) => {
          const ids = s.tasks.map((t) => t.id);
          // Pembagian dikunci setelah ada pengambilan (AMB) pertama: hanya Supervisor/Owner (backup) dengan alasan
          const hasAmb = s.pickups.some((p) => p.status !== "DIBATALKAN");
          // Hasil diisi saat penerimaan: tanpa pembagian & ambil setoran; koordinator lapor per pekerja, divisi menerima per jenis
          const free = !!s.resultAtReceipt;
          // Ubah jumlah kiriman: Owner/Supervisor (hak kelola borongan), selama belum selesai/ditutup
          const ubahQty = !free && fullAccess(scope) && s.state !== "SELESAI" && !s.closed;
          const bagi = !free && canDistribute(scope, { mode: s.mode, taskIds: ids }) && (!hasAmb || fullAccess(scope));
          const ambil = !free && canPickup(scope, { mode: s.mode, taskIds: ids }) && s.cells.some((c) => !c.done);
          const bWho = s.mode === "DRIVER" ? "Driver" : "tim divisi";
          // Hasil diisi saat penerimaan: laporan & penerimaan terkunci setelah disimpan; hanya Owner/Supervisor yang boleh mengubah (alasan wajib)
          const lapor = s.points.filter((p) => (free ? !s.reports.some((r) => r.pointId === p.id) || fullAccess(scope) : s.cells.some((c) => c.pointId === p.id)) && canReport(scope, { taskIds: ids }, p.id, p.coordinatorOnly ?? p.coordinator));
          const terimaJenis = free && canReceive(scope, s.tasks) ? s.points.filter((p) => notReceived(s, p.id) || fullAccess(scope)) : [];
          const activePickups = s.pickups.filter((p) => p.status !== "DIBATALKAN");
          const allotted = s.totals.allotted;
          return (
            <article key={s.id} className="card space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {coordinator ? <Link href={`/borongan/riwayat/${s.id}`} className="underline decoration-brand-300"><Chip>{s.number}</Chip></Link> : <Chip>{s.number}</Chip>}
                <span className="text-sm font-semibold text-slate-800">{fmtDay(dateOnly(s.date))}</span>
                <span className="ml-auto"><Badge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Badge></span>
              </div>
              <div className="break-words text-sm text-slate-700">{s.group} · {s.points.map((p) => p.name).join(", ")} · {s.mode === "DRIVER" ? `lewat driver${s.driver ? ` (${s.driver})` : ""}` : "diantar langsung"}</div>
              {free ? (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm tabular-nums">
                    <thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-2 py-1 text-left">Kroscek{s.points.length > 1 ? " · titik" : ""}</th>{s.tasks.map((t) => <th key={t.id} className="px-2 py-1 text-center">{t.short}</th>)}</tr></thead>
                    <tbody>
                      {s.points.map((p) => {
                        const cc = (t: string) => s.crosscheck?.find((c) => c.pointId === p.id && c.taskId === t);
                        return [
                          <tr key={`${p.id}r`} className="border-t border-slate-100"><td className="px-2 py-1 text-slate-600">Lapor koordinator{s.points.length > 1 ? ` · ${p.name}` : ""}</td>{s.tasks.map((t) => <td key={t.id} className="px-2 py-1 text-center">{s.reports.some((r) => r.pointId === p.id) ? f(cc(t.id)?.reported ?? 0) : "—"}</td>)}</tr>,
                          <tr key={`${p.id}d`} className="border-t border-slate-100"><td className="px-2 py-1 text-slate-600">Diterima divisi</td>{s.tasks.map((t) => <td key={t.id} className="px-2 py-1 text-center">{cc(t.id)?.received == null ? "—" : f(cc(t.id)!.received!)}</td>)}</tr>,
                          <tr key={`${p.id}s`} className="border-t border-slate-100 bg-slate-50 font-semibold"><td className="px-2 py-1">Selisih</td>{s.tasks.map((t) => { const c = cc(t.id); if (c?.received == null) return <td key={t.id} className="px-2 py-1 text-center">—</td>; const n = c.received - c.reported; return <td key={t.id} className={`px-2 py-1 text-center ${n ? "text-rose-700" : "text-emerald-700"}`}>{n > 0 ? "+" : ""}{f(n)}</td>; })}</tr>,
                        ];
                      })}
                    </tbody>
                  </table>
                  <p className="px-2 py-1 text-xs text-slate-500">Hasil diisi saat penerimaan · upah mengikuti yang diterima divisi, dihitung setelah laporan koordinator <b>dan</b> penerimaan sama-sama ada · setelah disimpan terkunci (ubah: Owner/Supervisor dengan alasan).</p>
                  {s.waiting && <p className="mx-2 mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">{s.waiting === "laporan" ? "Menunggu laporan koordinator — upah & klaim belum bisa" : "Menunggu penerimaan divisi — upah & klaim belum bisa"}</p>}
                </div>
              ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm keep-cols sm:grid-cols-4">
                <span className="text-slate-500">Dikirim <b className="text-slate-900">{f(s.totals.sent)}</b></span>
                <span className="text-slate-500">Dibagi <b className={allotted < s.totals.sent ? "text-amber-700" : "text-slate-900"}>{f(allotted)}</b></span>
                <span className="text-slate-500">Diambil <b className="text-slate-900">{f(s.cells.reduce((a, c) => a + c.diambil, 0))}</b></span>
                <span className="text-slate-500">Reject <b className="text-slate-900">{f(s.totals.reject)}</b></span>
              </div>
              )}
              {!free && allotted < s.totals.sent && <p className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">{allotted ? `Masih ${f(s.totals.sent - allotted)} pcs belum dibagi ke pekerja.` : "Belum dibagi ke pekerja."}</p>}
              {activePickups.length > 0 && (
                <ul className="space-y-1 text-xs text-slate-600">
                  {activePickups.map((p, i) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <Chip>{p.number}</Chip> ke-{i + 1} · {f(p.lines.reduce((a, l) => a + l.qty, 0))} pcs ·
                      {p.status === "DIBAWA" ? <span className="font-semibold text-amber-700">menunggu dihitung</span> : p.status === "KURANG" ? <span className="font-semibold text-rose-700">kurang, upah ditahan</span> : <span className="font-semibold text-emerald-700">diterima</span>}
                      {p.note && <span className="w-full break-words text-slate-500">{p.note}</span>}
                      {canCancelAmb(p.id, p.status) && (
                        <Modal trigger="Batalkan" triggerClass="text-xs font-semibold text-rose-600 underline" title={`Batalkan ${p.number}`} subtitle={p.status === "DIBAWA" ? "Belum dihitung divisi" : "Sudah dihitung divisi: setoran, stok & jurnal dibalik (Owner)"}>
                          <ModalForm action={batalAmbil} className="space-y-3" confirm={`Batalkan pengambilan ${p.number}? Tindakan ini tercatat di riwayat aktivitas.`}>
                            <input type="hidden" name="id" value={p.id} />
                            <p className="text-sm text-slate-600">{p.status === "DIBAWA" ? "Pengambilan hanya bisa dibatalkan pencatatnya pada hari yang sama; setelah itu oleh Supervisor/Owner." : "Hanya Owner. Upah yang sudah dibayar tidak bisa dibalik."}</p>
                            <label className="block"><span className="label">Alasan (wajib)</span><input name="reason" className="input" required minLength={3} placeholder="mis. salah hitung, salah titik" /></label>
                            <Submit className="btn-danger">Batalkan pengambilan</Submit>
                          </ModalForm>
                        </Modal>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {ubahQty && (
                  <Modal trigger="Ubah jumlah kiriman" triggerClass={allotted < s.totals.sent ? "btn-primary btn-sm" : "btn-secondary btn-sm"} title="Ubah jumlah kiriman" subtitle={`${s.number} · ${s.group}`} wide>
                    <ModalForm action={ubahJumlahKiriman} className="space-y-3"><UbahJumlahForm view={s} /></ModalForm>
                  </Modal>
                )}
                {bagi && (
                  <Modal trigger={`${allotted ? "Ubah pembagian" : "Bagi ke pekerja"}${bk(scope, bWho).label}`} triggerClass={allotted ? "btn-secondary btn-sm" : "btn-primary btn-sm"} title="Pembagian ke pekerja" subtitle={`${s.number} · ${s.group}`} wide>
                    <ModalForm action={simpanPembagian} className="space-y-3" confirm={bk(scope, bWho).confirm}>{bk(scope, bWho).note}{hasAmb && <label className="block"><span className="label">Alasan perubahan (wajib, pembagian sudah dikunci pengambilan)</span><input name="reason" className="input" required minLength={3} /></label>}<BagiForm view={s} canEditQty={ubahQty} workers={workers.filter((w) => s.points.some((p) => p.id === w.pointId)).map((w) => ({ ...w, pointId: w.pointId! }))} /></ModalForm>
                  </Modal>
                )}
                {lapor.map((p) => (
                  <Modal key={p.id} trigger={`${free && s.reports.some((r) => r.pointId === p.id) ? "Ubah laporan" : "Lapor hasil"}${s.points.length > 1 ? ` ${p.name}` : ""}${bk(scope, "Koordinator").label}`} triggerClass="btn-secondary btn-sm" title={`Lapor hasil · ${p.name}`} subtitle={s.number} wide>
                    <ModalForm action={laporHasil} className="space-y-3" confirm={bk(scope, "Koordinator").confirm}>{bk(scope, "Koordinator").note}{scope.backup && <label className="block"><span className="label">{free && s.reports.some((r) => r.pointId === p.id) ? "Alasan perubahan (wajib, laporan sudah terkunci)" : "Alasan koreksi (wajib bila sudah dihitung divisi)"}</span><input name="reason" className="input" required={free && s.reports.some((r) => r.pointId === p.id)} /></label>}<LaporForm view={s} pointId={p.id} workers={workers} /></ModalForm>
                  </Modal>
                ))}
                {terimaJenis.map((p) => (
                  <Modal key={`t${p.id}`} trigger={`${notReceived(s, p.id) ? "Terima hasil" : "Ubah penerimaan"}${s.points.length > 1 ? ` ${p.name}` : ""}${bk(scope, "divisi penerima").label}`} triggerClass={notReceived(s, p.id) ? "btn-primary btn-sm" : "btn-secondary btn-sm"} title={`Penerimaan hasil per jenis · ${p.name}`} subtitle={s.number} wide>
                    <ModalForm action={terimaHasilJenis} className="space-y-3" confirm={bk(scope, "divisi penerima").confirm}>{bk(scope, "divisi penerima").note}<TerimaJenisForm view={s} pointId={p.id} edit={!notReceived(s, p.id)} /></ModalForm>
                  </Modal>
                ))}
                {ambil && (
                  <Modal trigger={`Ambil setoran${bk(scope, bWho).label}`} triggerClass="btn-primary btn-sm" title="Ambil setoran" subtitle={`${s.number} · nomor AMB dibuat otomatis`} wide>
                    <ModalForm action={ambilSetoran} className="space-y-3" confirm={bk(scope, bWho).confirm}>{bk(scope, bWho).note}<AmbilForm view={s} /></ModalForm>
                  </Modal>
                )}
                {!activePickups.length && canCancelShipment(scope, { waitingSupport: false, createdById: shipCreators.get(s.id) ?? null, _count: { allots: s.totals.allotted > 0 ? 1 : 0 } }, userId) && (
                  <ActionForm action={batalKiriman} confirm={`Batalkan kiriman ${s.number}? Bahan kembali ke gudang.`}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm text-rose-600">Batalkan</button></ActionForm>
                )}
              </div>
            </article>
          );
        })}
      </section>
      )}

      {coordinator && active === "riwayat" && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Riwayat kiriman</h2>
          {!done.length ? <p className="text-sm text-slate-500">Belum ada kiriman yang selesai.</p> : (
            <div className="table-wrap">
              <Paged>
                <table className="tbl">
                  <thead><tr><th>Kiriman</th><th className="num">Dibagi</th><th className="num">Setor</th><th className="num">Reject</th></tr></thead>
                  <tbody>
                    {done.map((s) => (
                      <tr key={s.id}>
                        <td><Link href={`/borongan/riwayat/${s.id}`} className="font-mono text-xs font-semibold text-brand-700 underline">{s.number}</Link><div className="text-xs text-slate-500">{fmtDay(dateOnly(s.date))} · {s.tasks.map((t) => t.short).join(", ")}</div></td>
                        <td className="num">{f(s.totals.sent)}</td>
                        <td className="num">{f(s.totals.received)}</td>
                        <td className="num">{f(s.totals.reject)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Paged>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
