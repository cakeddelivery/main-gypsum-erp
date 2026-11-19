import { redirect } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { canSeeHistory } from "./riwayat/access";
import { PasswordInput } from "@/components/PasswordInput";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { stockBalances } from "@/lib/stock";
import { recipeUnit } from "@/lib/unitcost";
import { BORONGAN_ROLE_LABEL, HANDOVER_LABEL, boronganScope, canPoint, canWarehouse, isSetoranOnly, payLines, resultShares } from "@/lib/borongan";
import { Badge, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { StokTitikTab } from "./StokTitikTab";
import { PortalSetup } from "@/components/PushNotif";
import { pushPublicKey } from "@/lib/push";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { ItemLines } from "@/components/ItemLines";
import { ReceiveForm } from "./ReceiveForm";
import { KirimanTab } from "./KirimanTab";
import { taskKits } from "@/lib/boronganSetup";
import { initials } from "@/lib/initials";
import { taskGroupName } from "@/lib/boronganKirim";
import { shortTaskName } from "@/lib/boronganFlow";
import { KlaimTab } from "./KlaimTab";
import { diffLines, receiptDiff } from "@/lib/boronganReceipt";
import { dateOnly } from "@/lib/time";
import { cancelPayPoint, confirmHandover, payPoint, removePersonAction, removeResult, saveCoordinatorLogin, savePersonAction, savePointSettings, saveTask, sendHandover, voidDivisionReceipt, voidHandover } from "./actions";

export const metadata = { title: "Borongan" };

const TABS = [
  { key: "kiriman", label: "Kiriman" },
  { key: "stok", label: "Stok" },
  { key: "klaim", label: "Klaim Upah" },
  { key: "ringkasan", label: "Ringkasan" },
  { key: "serah", label: "Serah Terima (lama)" },
  { key: "hasil", label: "Setoran Hasil" },
  { key: "terima", label: "Penerimaan (lama)" },
  { key: "upah", label: "Bayar Upah (lama)" },
  { key: "orang", label: "Orang" },
  { key: "tugas", label: "Tugas & Tarif" },
];

export default async function BoronganPage({ searchParams }: { searchParams: Promise<{ tab?: string; f?: string; dari?: string; sampai?: string }> }) {
  const user = await requirePerm("borongan.view", "borongan.point", "borongan.manage", "borongan.driver");
  const sp = await searchParams;
  const scope = await boronganScope(prisma, user);
  const manage = scope.all;
  const pointFilter = manage ? {} : { id: { in: scope.pointIds } };
  const resultFilter = manage ? {} : { pointId: { in: scope.pointIds } };
  // Anggota divisi: hanya setoran tugas divisinya
  const setoranOnly = isSetoranOnly(scope);
  const isCoordinatorOnly = !manage && !scope.driver && !scope.division && !!scope.personId;
  const taskFilter = scope.taskIds ? { taskId: { in: scope.taskIds } } : {};
  const tabs = TABS.filter((t) => manage || !["tugas"].includes(t.key))
    .filter((t) => t.key !== "upah" || manage || user.can("borongan.pay"))
    .filter((t) => !setoranOnly || ["kiriman", "klaim", "ringkasan", "hasil", "terima"].includes(t.key))
    // Driver: hanya Pembagian & Ambil Setoran (tab Kiriman)
    .filter((t) => !scope.driver || t.key === "kiriman")
    // Koordinator titik: lapor hasil (Kiriman), Klaim Upah, dan pekerja titiknya (Orang)
    .filter((t) => !isCoordinatorOnly || ["kiriman", "stok", "klaim", "orang"].includes(t.key))
    // Stok bahan titik: koordinator & pengelola
    .filter((t) => t.key !== "stok" || isCoordinatorOnly || manage)
    // Tim Cetak/Oven (isi patung kering) & Packing (terima setoran Assembling): hanya Kiriman
    .filter((t) => !(scope.kering || scope.packing) || t.key === "kiriman");
  // Finance (hanya bayar upah): langsung ke Klaim Upah
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : !manage && !scope.pointIds.length && user.can("borongan.pay") ? "klaim" : "kiriman";
  if (scope.driver) {
    return (
      <div className="space-y-4">
        <PageHeader title="Borongan" subtitle="Pembagian ke pekerja & ambil setoran" />
        <PortalSetup publicKey={pushPublicKey()} />
        <KirimanTab scope={scope} userId={user.id} filter={sp.f} />
      </div>
    );
  }

  const [points, people, tasks, items, banks, pending, balances] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { active: true, ...pointFilter }, include: { location: true }, orderBy: { code: "asc" } }),
    prisma.boronganPerson.findMany({ where: manage ? {} : { OR: [{ pointId: { in: scope.pointIds } }, { role: "DRIVER" }] }, include: { point: true, user: true }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.pieceTask.findMany({ include: { inputs: { include: { item: true } }, outputItem: true }, orderBy: { name: "asc" } }),
    prisma.item.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.boronganHandover.findMany({ where: { status: "DIKIRIM", ...resultFilter }, include: { lines: { include: { item: true } }, point: true, driver: true }, orderBy: { date: "asc" } }),
    stockBalances(prisma),
  ]);
  const history = await canSeeHistory(user);
  // Finance (bayar upah) tetap membuka halaman ini (tab Klaim Upah) walau tidak punya titik
  if (!manage && !points.length && !user.can("borongan.pay")) {
    // Tim Oven tanpa titik: langsung ke Riwayat Pengiriman
    if (history) redirect("/borongan/riwayat");
    return (
      <div className="space-y-5">
        <PageHeader title="Borongan" />
        <Empty title="Akun Anda belum terhubung ke titik borongan" hint="Minta pengelola menghubungkan login Anda ke data koordinator." />
      </div>
    );
  }
  const itemById = new Map(items.map((i) => [i.id, i]));
  const stockAt = (locationId: string) => balances.filter((b) => b.locationId === locationId && Math.abs(b.qty) > 0.0005).map((b) => ({ ...b, item: itemById.get(b.itemId) })).filter((b) => b.item);
  const divisions = manage ? await prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, name: true } }) : [];
  const divisionName = new Map((await prisma.division.findMany({ select: { id: true, name: true } })).map((d) => [d.id, d.name]));
  const drivers = people.filter((p) => p.role === "DRIVER" && p.active);
  const t = todayStr();
  const driverField = drivers.length > 0 && (
    <Field label="Driver"><select name="driverId" className="input" defaultValue={drivers[0].id}>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
  );

  const sendBack = (
    <Modal trigger="+ Kirim Hasil Ke Gudang" triggerClass="btn-secondary" title="Kirim hasil ke gudang lewat driver" wide>
      <ModalForm action={sendHandover} className="space-y-3">
        <input type="hidden" name="kind" value="KEMBALI" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Dari titik"><select name="pointId" className="input">{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          {driverField}
          <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
        </div>
        <ItemLines items={points.length === 1 ? stockAt(points[0].locationId).filter((b) => b.qty > 0).map((b) => ({ id: b.itemId, name: b.item!.name, unit: b.item!.unit, stock: Math.round(b.qty * 1000) / 1000 })) : items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))} />
        <Field label="Catatan"><input name="note" className="input" /></Field>
        <Submit>Serahkan Ke Driver</Submit>
      </ModalForm>
    </Modal>
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title="Borongan"
        subtitle={canWarehouse(scope) ? "Kiriman bernomor: kirim bahan → bagi ke pekerja → lapor hasil → ambil setoran → diterima divisi" : `Titik ${points.map((p) => p.name).join(", ")}`}
        actions={tab === "serah" && !setoranOnly ? <div className="flex flex-wrap gap-2">{sendBack}</div> : undefined}
      />
      {/* Koordinator: menu tab pindah ke navigasi bawah */}
      {!isCoordinatorOnly && <Tabs current={tab} tabs={[...tabs.map((x) => ({ ...x, href: `?tab=${x.key}`, count: x.key === "serah" ? pending.length || undefined : undefined })), ...(history ? [{ key: "riwayat", label: "Riwayat", href: "/borongan/riwayat" }] : [])]} />}

      {isCoordinatorOnly && tab === "kiriman" && <PortalSetup publicKey={pushPublicKey()} />}
      {tab === "kiriman" && <KirimanTab scope={scope} userId={user.id} filter={sp.f} />}
      {tab === "stok" && <StokTitikTab scope={scope} />}
      {tab === "klaim" && <KlaimTab scope={scope} canPay={user.can("borongan.pay")} />}
      {tab === "ringkasan" && (
        <>
          {pending.length > 0 && !setoranOnly && <PendingList pending={pending} scope={scope} />}
          <div className="grid gap-5 lg:grid-cols-2">
            {points.map((p) => <PointCard key={p.id} point={p} stock={stockAt(p.locationId)} people={people.filter((x) => x.pointId === p.id && x.active)} />)}
          </div>
        </>
      )}
      {tab === "serah" && <HandoverTab scope={scope} pending={pending} filter={resultFilter} />}
      {tab === "terima" && <ReceiptTab scope={scope} userId={user.id} from={sp.dari} to={sp.sampai} />}
      {tab === "hasil" && <ResultsTab filter={{ ...resultFilter, ...taskFilter }} scope={scope} userId={user.id} />}
      {tab === "upah" && <WagesTab points={points} banks={banks} canPay={user.can("borongan.pay")} />}
      {tab === "orang" && <PeopleTab people={people} points={points} manage={manage} canLogin={manage} tasks={tasks.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, division: divisionName.get(t.divisionId ?? "") ?? null }))} />}
      {tab === "tugas" && manage && (
        <>
          <PointsCard points={points.map((p) => ({ id: p.id, name: p.name, viaDriver: p.viaDriver, noCoordinator: p.noCoordinator, coordinators: people.filter((x) => x.role === "KOORDINATOR" && x.active && x.pointId === p.id).map((x) => x.name) }))} />
          <TasksTab tasks={tasks} items={items} divisions={divisions} kits={await taskKits(prisma)} />
        </>
      )}
    </div>
  );
}

type Scope = Awaited<ReturnType<typeof boronganScope>>;
type Pending = Awaited<ReturnType<typeof prisma.boronganHandover.findMany<{ include: { lines: { include: { item: true } }; point: true; driver: true } }>>>;

function HandoverLines({ h }: { h: Pending[number] }) {
  return <ul className="mt-1 text-xs text-slate-600">{h.lines.map((l) => <li key={l.id}>{l.item.name}: {Number(l.qty).toLocaleString("id-ID")} {l.item.unit}</li>)}</ul>;
}

function PendingList({ pending, scope }: { pending: Pending; scope: Scope }) {
  return (
    <Card title="Menunggu konfirmasi terima">
      <ul className="divide-y divide-slate-100 text-sm">
        {pending.map((h) => {
          const canReceive = h.kind === "KIRIM" ? canPoint(scope, h.pointId) : canWarehouse(scope);
          const canCancel = h.kind === "KIRIM" ? canWarehouse(scope) : canPoint(scope, h.pointId);
          return (
            <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <p><b>{HANDOVER_LABEL[h.kind]}</b> · {h.point.name} · {fmtDay(h.date)}{h.driver && ` · driver ${h.driver.name}`}</p>
                <HandoverLines h={h} />
              </div>
              <div className="flex gap-2">
                {canReceive && <ActionForm action={confirmHandover} confirm="Barang sudah diterima lengkap?"><input type="hidden" name="id" value={h.id} /><Submit className="btn-success btn-sm" pendingText="…">Terima</Submit></ActionForm>}
                {canCancel && <ActionForm action={voidHandover} confirm="Batalkan serah terima ini? Barang kembali ke asal."><input type="hidden" name="id" value={h.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Batal</Submit></ActionForm>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PointCard({ point, stock, people }: { point: { name: string }; stock: { itemId: string; qty: number; item?: { name: string; unit: string } }[]; people: { id: string; name: string; role: keyof typeof BORONGAN_ROLE_LABEL }[] }) {
  const coord = people.filter((p) => p.role === "KOORDINATOR");
  const workers = people.filter((p) => p.role === "PEKERJA");
  return (
    <Card title={`Titik ${point.name}`}>
      <p className="text-sm text-slate-600">Koordinator: <b>{coord.map((c) => c.name).join(", ") || "belum ada"}</b> · {workers.length} pekerja aktif</p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Sisa bahan &amp; barang di titik</p>
      {stock.length === 0 ? <p className="text-sm text-slate-400">Kosong</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {stock.map((s) => <li key={s.itemId} className="flex justify-between py-1"><span>{s.item!.name}</span><span className={`tabular-nums ${s.qty < 0 ? "font-semibold text-rose-600" : ""}`}>{(Math.round(s.qty * 1000) / 1000).toLocaleString("id-ID")} {s.item!.unit}</span></li>)}
        </ul>
      )}
      {stock.some((s) => s.qty < 0) && <p className="mt-2 text-xs text-rose-600">Stok minus: bahan terpakai lebih banyak dari yang dikirim. Periksa resep tugas atau kirim bahan yang belum dicatat.</p>}
    </Card>
  );
}

async function HandoverTab({ scope, pending, filter }: { scope: Scope; pending: Pending; filter: object }) {
  const done = await prisma.boronganHandover.findMany({ where: { status: { not: "DIKIRIM" }, ...filter }, include: { lines: { include: { item: true } }, point: true, driver: true }, orderBy: { date: "desc" }, take: 100 });
  return (
    <div className="space-y-5">
      {pending.length > 0 ? <PendingList pending={pending} scope={scope} /> : <p className="text-sm text-slate-500">Tidak ada serah terima yang menunggu.</p>}
      <Card title="Riwayat serah terima">
        {done.length === 0 ? <Empty /> : (
          <Paged><table className="tbl">
            <thead><tr><th>Tanggal</th><th>Jenis</th><th>Titik</th><th>Barang</th><th>Driver</th><th>Status</th></tr></thead>
            <tbody>{done.map((h) => (
              <tr key={h.id}>
                <td>{fmtDay(h.date)}</td><td>{HANDOVER_LABEL[h.kind]}</td><td>{h.point.name}</td>
                <td className="text-xs">{h.lines.map((l) => `${l.item.name} ${Number(l.qty).toLocaleString("id-ID")} ${l.item.unit}`).join(", ")}</td>
                <td>{h.driver?.name ?? "—"}</td>
                <td>{h.status === "DITERIMA" ? <Badge tone="green">Diterima {h.receivedBy}</Badge> : <Badge>Dibatalkan</Badge>}</td>
              </tr>
            ))}</tbody>
          </table></Paged>
        )}
      </Card>
    </div>
  );
}

async function ResultsTab({ filter, scope, userId }: { filter: object; scope: Scope; userId: string }) {
  // Pengelola & kapten: semua setoran yang terlihat; anggota divisi: hanya setoran yang ia catat sendiri
  const canDelete = (r: { createdById: string | null }) => !scope.division || scope.division.captain || !!scope.warehouse || r.createdById === userId;
  const rows = await prisma.boronganResult.findMany({ where: filter, include: { worker: true, task: true, point: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200 });
  return (
    <Card title="Setoran hasil kerja">
      {rows.length === 0 ? <Empty title="Belum ada setoran" /> : (
        <Paged><table className="tbl">
          <thead><tr><th>Tanggal</th><th>Titik</th><th>Pekerja</th><th>Tugas</th><th className="num">Bagus</th><th className="num">Reject</th><th className="num">Upah Pekerja</th><th className="num">Total Budget</th><th>Status</th><th>Dicatat</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const s = resultShares(r.qty, { workerRate: Number(r.workerRate), coordinatorRate: Number(r.coordinatorRate), driverRate: Number(r.driverRate) });
            return (
              <tr key={r.id}>
                <td>{fmtDay(r.date)}</td><td>{r.point.name}</td><td>{r.worker.name}</td><td>{r.task.name}</td>
                <td className="num">{r.qty.toLocaleString("id-ID")}</td><td className={`num ${r.reject ? "text-rose-600" : "text-slate-400"}`}>{r.reject.toLocaleString("id-ID")}</td><td className="num">{idr(s.worker)}</td><td className="num">{idr(s.total)}</td>
                <td>{r.settlementId ? <Badge tone="green">Dibayar</Badge> : <Badge tone="amber">Belum Dibayar</Badge>}</td>
                <td className="text-xs text-slate-500">{r.createdBy}</td>
                <td>{!r.settlementId && canDelete(r) && <ActionForm action={removeResult} confirm="Batalkan setoran ini? Stok bahan & hasil dikembalikan, tercatat di audit."><input type="hidden" name="id" value={r.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Batalkan</Submit></ActionForm>}</td>
              </tr>
            );
          })}</tbody>
        </table></Paged>
      )}
    </Card>
  );
}

async function WagesTab({ points, banks, canPay }: { points: { id: string; name: string }[]; banks: { id: string; name: string }[]; canPay: boolean }) {
  const [unpaid, history] = await Promise.all([
    prisma.boronganResult.findMany({ where: { settlementId: null, pointId: { in: points.map((p) => p.id) } }, include: { worker: true, coordinator: true, driver: true }, orderBy: { date: "asc" } }),
    prisma.boronganSettlement.findMany({ where: { pointId: { in: points.map((p) => p.id) } }, include: { point: true, results: { include: { worker: true, coordinator: true, driver: true } } }, orderBy: { date: "desc" }, take: 30 }),
  ]);
  const t = todayStr();
  // Peringatan sebelum pelunasan: setoran koordinator (belum dibayar) vs penerimaan divisi berbeda
  const warn: string[] = [];
  if (unpaid.length) {
    const from = unpaid[0].date;
    const divs = await prisma.division.findMany({ where: { pieceTasks: { some: { active: true, outputItemId: { not: null } } } } });
    for (const d of divs) warn.push(...diffLines(await receiptDiff(d.id, from, dateOnly(t))).map((l) => `${d.name}: ${l}`));
  }
  return (
    <div className="space-y-5">
      {warn.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-1 font-semibold">⚠ Setoran koordinator berbeda dengan penerimaan divisi (sejak setoran belum dibayar tertua)</div>
          <ul className="list-disc space-y-0.5 pl-5">{warn.map((w) => <li key={w}>{w}</li>)}</ul>
          <p className="mt-1 text-xs">Upah dihitung dari catatan koordinator. Periksa dulu sebelum melunasi (lihat tab Penerimaan &amp; Selisih).</p>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {points.map((p) => {
          const rs = unpaid.filter((r) => r.pointId === p.id);
          const lines = payLines(rs);
          const total = lines.reduce((s, l) => s + l.amount, 0);
          return (
            <Card key={p.id} title={`Belum dibayar · ${p.name}`} actions={canPay && total > 0 && (
              <Modal trigger="Bayar Upah" triggerClass="btn-success btn-sm" title={`Bayar upah borongan ${p.name}`}>
                <ModalForm action={payPoint} className="space-y-3">
                  <input type="hidden" name="pointId" value={p.id} />
                  <Field label="Bayar setoran sampai tanggal"><input type="date" name="upTo" defaultValue={t} className="input" /></Field>
                  <Field label="Dibayar dari"><select name="bankAccountId" className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <p className="text-sm">Total <b>{idr(total)}</b> untuk pekerja, koordinator, dan jatah driver. Jatah driver dibukukan sebagai beban transport borongan, terpisah dari Kompensasi Pengelola.</p>
                  <Submit>Bayar</Submit>
                </ModalForm>
              </Modal>
            )}>
              {lines.length === 0 ? <p className="text-sm text-slate-500">Semua upah sudah dibayar.</p> : <PayTable lines={lines} />}
            </Card>
          );
        })}
      </div>
      <Card title="Riwayat pembayaran upah">
        {history.length === 0 ? <Empty title="Belum ada pembayaran" /> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2 py-2">
                <span>{fmtDay(h.date)} · {h.point.name} · s.d. {fmtDay(h.upTo)}{h.cancelledAt && <> · <Badge tone="gray">Dibatalkan</Badge></>}</span>
                <span className="flex items-center gap-2"><b className={`tabular-nums ${h.cancelledAt ? "text-slate-400 line-through" : ""}`}>{idr(h.total)}</b>
                  {!h.cancelledAt && <Modal trigger="Rincian" triggerClass="btn-secondary btn-sm" title={`Rincian ${h.number}`}><PayTable lines={payLines(h.results)} /></Modal>}
                  {!h.cancelledAt && canPay && (
                    <Modal trigger="Batalkan" triggerClass="btn-secondary btn-sm" title={`Batalkan ${h.number}`}>
                      <ModalForm action={cancelPayPoint} className="space-y-3">
                        <input type="hidden" name="id" value={h.id} />
                        <Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field>
                        <p className="text-xs text-slate-500">Jurnal pembayaran dibalik dan setorannya kembali menjadi belum dibayar.</p>
                        <Submit className="btn-danger">Batalkan pembayaran</Submit>
                      </ModalForm>
                    </Modal>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PayTable({ lines }: { lines: ReturnType<typeof payLines> }) {
  return (
    <table className="tbl">
      <thead><tr><th>Nama</th><th>Sebagai</th><th className="num">Pcs</th><th className="num">Upah</th></tr></thead>
      <tbody>
        {lines.map((l) => <tr key={`${l.role}${l.personId}`}><td>{l.name}</td><td>{BORONGAN_ROLE_LABEL[l.role]}</td><td className="num">{l.qty.toLocaleString("id-ID")}</td><td className="num">{idr(l.amount)}</td></tr>)}
        <tr><td colSpan={3} className="font-semibold">Total</td><td className="num font-semibold">{idr(lines.reduce((s, l) => s + l.amount, 0))}</td></tr>
      </tbody>
    </table>
  );
}

type PersonRow = Awaited<ReturnType<typeof prisma.boronganPerson.findMany<{ include: { point: true; user: true } }>>>[number];

type TaskOpt = { id: string; name: string; division: string | null };

function PersonForm({ p, points, manage, tasks, coordinators = [] }: { p?: PersonRow; points: { id: string; name: string }[]; manage: boolean; tasks: TaskOpt[]; coordinators?: { id: string; name: string; point: string }[] }) {
  // Jenis pekerjaan dikelompokkan per divisi pencatat setoran (divisi tugas)
  const byDiv = Object.entries(tasks.reduce<Record<string, TaskOpt[]>>((m, t) => ((m[t.division ?? "Tanpa divisi"] ??= []).push(t), m), {}));
  return (
    <ModalForm action={savePersonAction} className="space-y-3">
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Nama"><input name="name" defaultValue={p?.name} className="input" required /></Field>
      <Field label="No. HP"><input name="phone" type="tel" defaultValue={p?.phone ?? ""} className="input" /></Field>
      {manage ? (
        <>
          <Field label="Sebagai"><select name="role" defaultValue={p?.role ?? "PEKERJA"} className="input">{(["PEKERJA", "KOORDINATOR", "DRIVER"] as const).map((r) => <option key={r} value={r}>{BORONGAN_ROLE_LABEL[r]}</option>)}</select></Field>
          <Field label="Titik" hint="Driver tidak terikat titik"><select name="pointId" defaultValue={p?.pointId ?? points[0]?.id} className="input">{points.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        </>
      ) : <input type="hidden" name="role" value="PEKERJA" />}
      {(!p || p.role === "PEKERJA") && tasks.length > 0 && (
        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-600">Jenis pekerjaan (khusus pekerja)</legend>
          <input type="hidden" name="tasksSent" value="1" />
          <p className="mb-2 text-xs text-slate-500">Setoran pekerja ini hanya bisa dicatat untuk pekerjaan yang dicentang, di laporan divisinya. Kosongkan semua = boleh semua pekerjaan di titiknya.</p>
          <div className="space-y-2">
            {byDiv.map(([div, ts]) => (
              <div key={div}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{div}</p>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {ts.map((t) => (
                    <label key={t.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="taskIds" value={t.id} defaultChecked={p?.taskIds.includes(t.id)} className="h-4 w-4" /> {t.name}</label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {manage && (!p || p.role === "PEKERJA") && (
        <Field label="Koordinator (khusus pekerja)" hint="Tanpa koordinator: bagian upah koordinator dibayarkan ke pekerja (mis. Cat Plastik Rp13 + Rp2 = Rp15).">
          <select name="coordinatorId" defaultValue={p?.noCoordinator ? "-" : p?.coordinatorId ?? ""} className="input">
            <option value="">Ikut koordinator titik (bila ada)</option>
            {coordinators.map((c) => <option key={c.id} value={c.id}>{c.name}{c.point ? ` · ${c.point}` : ""}</option>)}
            <option value="-">Tanpa koordinator (upah utuh ke pekerja)</option>
          </select>
        </Field>
      )}
      {p && <Field label="Status"><select name="active" defaultValue={p.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Field label="Catatan"><input name="note" defaultValue={p?.note ?? ""} className="input" /></Field>
      <Submit>Simpan</Submit>
    </ModalForm>
  );
}

/** Ringkas jenis pekerjaan jadi chip per kelompok: "Assembling: Cowok · Cewek", "Cat Giftbox" */
function taskChips(ids: string[], taskName: Map<string, TaskOpt>) {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const t = taskName.get(id);
    if (!t) continue;
    const g = taskGroupName(t.name);
    const short = shortTaskName(t.name);
    const list = groups.get(g) ?? [];
    if (short.toLowerCase() !== g.toLowerCase() && !list.includes(short)) list.push(short);
    groups.set(g, list);
  }
  return [...groups].map(([g, xs]) => (xs.length ? `${g}: ${xs.join(" · ")}` : g));
}

const ROLE_ORDER = { KOORDINATOR: 0, PEKERJA: 1, DRIVER: 2 } as const;

function PeopleTab({ people, points, manage, canLogin, tasks }: { people: PersonRow[]; points: { id: string; name: string }[]; manage: boolean; canLogin: boolean; tasks: TaskOpt[] }) {
  const taskName = new Map(tasks.map((t) => [t.id, t]));
  const coordinators = people.filter((x) => x.role === "KOORDINATOR" && x.active).map((x) => ({ id: x.id, name: x.name, point: x.point?.name ?? "" }));
  const sorted = (rows: PersonRow[]) => [...rows].sort((a, b) => Number(b.active) - Number(a.active) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name, "id"));
  const groups = [...points.map((p) => ({ key: p.id, title: `Titik ${p.name}`, rows: sorted(people.filter((x) => x.pointId === p.id)) })), ...(manage ? [{ key: "drv", title: "Driver", rows: sorted(people.filter((x) => x.role === "DRIVER")) }] : [])];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-slate-500" title="Pekerja borongan adalah tetangga, bukan karyawan: tidak masuk absensi, gaji bulanan, atau kasbon.">Pekerja borongan = tetangga, bukan karyawan (tanpa absensi/gaji/kasbon).</p>
        <Modal trigger={manage ? "+ Orang" : "+ Pekerja"} triggerClass="btn-primary btn-sm shrink-0" title={manage ? "Tambah orang borongan" : "Tambah pekerja"}><PersonForm points={points} manage={manage} tasks={tasks} coordinators={coordinators} /></Modal>
      </div>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {groups.map((g) => (
          <Card key={g.key} title={`${g.title} · ${g.rows.filter((r) => r.active).length} orang`}>
            {g.rows.length === 0 ? <p className="text-sm text-slate-400">Belum ada</p> : (
              <ul className="divide-y divide-slate-100">
                {g.rows.map((p) => {
                  const editable = manage || p.role === "PEKERJA";
                  const chips = p.role === "PEKERJA" ? taskChips(p.taskIds, taskName) : [];
                  return (
                    <li key={p.id} className={`flex items-center gap-3 py-2.5 ${p.active ? "" : "opacity-50"}`}>
                      <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold ${p.role === "KOORDINATOR" ? "bg-brand-600 text-white" : p.role === "DRIVER" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>{initials(p.name)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={`min-w-0 truncate text-sm font-semibold text-slate-900 ${p.active ? "" : "line-through"}`}>{p.name}</span>
                          <span className="shrink-0"><Badge tone={p.role === "KOORDINATOR" ? "blue" : p.role === "DRIVER" ? "amber" : "gray"}>{BORONGAN_ROLE_LABEL[p.role]}</Badge></span>
                        </div>
                        {p.role === "PEKERJA" ? (
                          chips.length ? (
                            <div className="mt-1 flex flex-wrap gap-1">{chips.map((c) => <span key={c} className="max-w-full rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 [overflow-wrap:anywhere]">{c}</span>)}</div>
                          ) : <div className="text-xs text-amber-700">Jenis pekerjaan belum diatur</div>
                        ) : p.user ? <div className="truncate text-xs text-slate-500">login: {p.user.username}</div> : null}
                      </div>
                      {editable && (
                        <details className="relative shrink-0">
                          <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full text-lg text-slate-500 hover:bg-slate-100 [&::-webkit-details-marker]:hidden" aria-label={`Menu ${p.name}`}>⋯</summary>
                          <div className="absolute right-0 z-20 mt-1 flex w-40 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                            <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm w-full justify-start" title={`Ubah ${p.name}`}><PersonForm p={p} points={points} manage={manage} tasks={tasks} coordinators={coordinators} /></Modal>
                            {canLogin && (p.role === "KOORDINATOR" || p.role === "DRIVER") && (
                              <Modal trigger={p.user ? "Login" : "Buat login"} triggerClass="btn-secondary btn-sm w-full justify-start" title={`Login ${p.role === "DRIVER" ? "driver" : "koordinator"} ${p.name}`}>
                                <ModalForm action={saveCoordinatorLogin} className="space-y-3">
                                  <input type="hidden" name="personId" value={p.id} />
                                  <Field label="Username"><input name="username" defaultValue={p.user?.username ?? ""} className="input" autoComplete="off" required /></Field>
                                  <Field label={p.user ? "Password baru (kosongkan bila tetap)" : "Password"}><PasswordInput name="password" className="input" autoComplete="new-password" minLength={8} /></Field>
                                  <p className="text-xs text-slate-500">{p.role === "DRIVER" ? "Driver hanya melihat Borongan › Kiriman: pembagian ke pekerja dan ambil setoran." : "Koordinator hanya melihat titiknya: lapor hasil kerja per pekerja, stok titik, klaim upah, dan mengelola pekerja."}</p>
                                  <Submit>Simpan</Submit>
                                </ModalForm>
                              </Modal>
                            )}
                            {p.active && <ActionForm action={removePersonAction} confirm={`Hapus ${p.name}? Yang sudah punya riwayat setoran hanya dinonaktifkan.`}><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary btn-sm w-full justify-start text-rose-700" pendingText="…">Hapus</Submit></ActionForm>}
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

type TaskRow = Awaited<ReturnType<typeof prisma.pieceTask.findMany<{ include: { inputs: { include: { item: true } }; outputItem: true } }>>>[number];
type ItemRow = Awaited<ReturnType<typeof prisma.item.findMany>>[number];

function TaskForm({ task, items, divisions, kit = [] }: { task?: TaskRow; items: ItemRow[]; divisions: { id: string; name: string }[]; kit?: string[] }) {
  return (
    <ModalForm action={saveTask} className="space-y-3">
      {task && <input type="hidden" name="id" value={task.id} />}
      <Field label="Nama tugas"><input name="name" defaultValue={task?.name} className="input" required /></Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Pekerja (Rp/pcs)"><input name="workerRate" inputMode="numeric" defaultValue={task ? Number(task.workerRate) : ""} className="input" required /></Field>
        <Field label="Koordinator"><input name="coordinatorRate" inputMode="numeric" defaultValue={task ? Number(task.coordinatorRate) : 0} className="input" /></Field>
        <Field label="Driver"><input name="driverRate" inputMode="numeric" defaultValue={task ? Number(task.driverRate) : 0} className="input" /></Field>
      </div>
      <p className="text-xs text-slate-500">Budget total per pcs = pekerja + koordinator + driver.</p>
      <Field label="Divisi pencatat setoran" hint="Anggota divisi ini boleh mencatat & membatalkan setoran tugas ini"><select name="divisionId" defaultValue={task?.divisionId ?? ""} className="input"><option value="">— hanya pengelola & koordinator —</option>{divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Barang hasil (masuk stok titik)"><select name="outputItemId" defaultValue={task?.outputItemId ?? ""} className="input"><option value="">— tanpa stok hasil —</option>{items.filter((i) => i.type !== "BAHAN_BAKU").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
      <div>
        <span className="label">Bahan terpakai per 1 pcs hasil</span>
        <ItemLines items={items.map((i) => ({ id: i.id, name: i.name, unit: recipeUnit(i) }))} initial={task?.inputs.map((x) => ({ itemId: x.itemId, qty: Number(x.qty) })) ?? []} qtyLabel="Per pcs" emptyLabel="— pilih bahan —" />
      </div>
      <fieldset className="rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-medium text-slate-600">Bahan pendukung yang ikut dikirim (kit)</legend>
        <input type="hidden" name="kitSent" value="1" />
        <p className="mb-2 text-xs text-slate-500">Muncul di form Kirim Cat / Kirim Assembling untuk jenis pekerjaan ini. Bahan per pcs di atas sudah ikut otomatis.</p>
        <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
          {items.map((i) => <label key={i.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="kitIds" value={i.id} defaultChecked={kit.includes(i.id)} className="h-4 w-4 shrink-0" /><span className="break-words">{i.name}</span></label>)}
        </div>
      </fieldset>
      {task && <Field label="Status"><select name="active" defaultValue={task.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );
}

/** Setelan per titik: cara kirim bawaan & ada tidaknya koordinator (tanpa koordinator → upah koordinator ke pekerja) */
function PointsCard({ points }: { points: { id: string; name: string; viaDriver: boolean; noCoordinator: boolean; coordinators: string[] }[] }) {
  return (
    <Card title="Titik borongan">
      <ul className="divide-y divide-slate-100">
        {points.map((p) => (
          <li key={p.id} className="py-3">
            <ActionForm action={savePointSettings} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <input type="hidden" name="id" value={p.id} />
              <div className="min-w-0 flex-1 basis-40">
                <div className="font-semibold text-slate-900">{p.name}</div>
                <div className="text-xs text-slate-500">{p.noCoordinator ? "Tanpa koordinator: upah koordinator dibayarkan ke pekerja" : p.coordinators.length ? `Koordinator: ${p.coordinators.join(", ")}` : "Belum ada koordinator: upah koordinator ke pekerja"}</div>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="viaDriver" defaultChecked={p.viaDriver} className="h-4 w-4" /> Lewat driver</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="noCoordinator" defaultChecked={p.noCoordinator} className="h-4 w-4" /> Tanpa koordinator</label>
              <Submit className="btn-secondary btn-sm">Simpan</Submit>
            </ActionForm>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">Ada koordinator: bagian koordinator (mis. Cat Plastik Rp2) untuk koordinator. Tanpa koordinator: pekerja menerima penuh (Rp15). Pilihan per pekerja di tab Orang lebih diutamakan.</p>
    </Card>
  );
}

function TasksTab({ tasks, items, divisions, kits }: { tasks: TaskRow[]; items: ItemRow[]; divisions: { id: string; name: string }[]; kits: Record<string, string[]> }) {
  return (
    <Card title="Tugas & pembagian budget per pcs" actions={<Modal trigger="+ Tugas" triggerClass="btn-primary btn-sm" title="Tugas borongan baru" wide><TaskForm items={items} divisions={divisions} /></Modal>}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Tugas</th><th>Divisi pencatat</th><th className="num">Budget</th><th className="num">Pekerja</th><th className="num">Koordinator</th><th className="num">Driver</th><th>Hasil & Bahan</th><th /></tr></thead>
          <tbody>{tasks.map((x) => (
            <tr key={x.id} className={x.active ? "" : "opacity-50"}>
              <td>{x.name}</td><td>{divisions.find((d) => d.id === x.divisionId)?.name ?? <span className="text-slate-400">—</span>}</td><td className="num">{idr(x.ratePerPcs)}</td><td className="num">{idr(x.workerRate)}</td><td className="num">{idr(x.coordinatorRate)}</td><td className="num">{idr(x.driverRate)}</td>
              <td className="text-xs">{x.outputItem ? `→ ${x.outputItem.name}` : "—"}{x.inputs.length > 0 && <><br />{x.inputs.map((i) => `${i.item.name} ${Number(i.qty).toLocaleString("id-ID")} ${recipeUnit(i.item)}`).join(", ")}</>}</td>
              <td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${x.name}`} wide><TaskForm task={x} items={items} divisions={divisions} kit={kits[x.id] ?? []} /></Modal></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}


/**
 * Penerimaan hasil borongan oleh divisi + selisih terhadap setoran koordinator (per barang & per titik).
 * Pengelola: semua divisi; anggota divisi: divisinya; koordinator: hanya titiknya.
 */
async function ReceiptTab({ scope, userId, from, to }: { scope: Scope; userId: string; from?: string; to?: string }) {
  const isD = (x?: string) => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const end = isD(to) ? to! : todayStr();
  const start = isD(from) ? from! : `${end.slice(0, 8)}01`;
  const divisions = await prisma.division.findMany({ where: { active: true, pieceTasks: { some: { active: true, outputItemId: { not: null } } }, ...(scope.all || !scope.division ? {} : { id: scope.division.id }) }, orderBy: { code: "asc" } });
  const pointFilter = (p: { pointId: string }) => scope.all || !!scope.division || scope.pointIds.includes(p.pointId);
  const f = (n: number) => n.toLocaleString("id-ID");
  const canAdd = (d: string) => scope.all || scope.division?.id === d;
  const blocks = await Promise.all(divisions.map(async (d) => ({
    d,
    diff: await receiptDiff(d.id, dateOnly(start), dateOnly(end)),
    receipts: await prisma.boronganReceipt.findMany({ where: { divisionId: d.id, date: { gte: dateOnly(start), lte: dateOnly(end) } }, include: { lines: { include: { item: true, point: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 50 }),
  })));
  return (
    <div className="space-y-5">
      <form className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="terima" />
        <label><span className="label">Dari</span><input type="date" name="dari" defaultValue={start} className="input" /></label>
        <label><span className="label">Sampai</span><input type="date" name="sampai" defaultValue={end} className="input" /></label>
        <button className="btn-secondary">Tampilkan</button>
      </form>
      <p className="text-sm text-slate-500">Setoran = catatan koordinator per pekerja (dasar upah). Diterima = rekap divisi per barang (masuk gudang). Selisih minus = belum/kurang diterima, plus = diterima lebih dari setoran. Sisa di titik = setoran yang belum diterima (semua tanggal).</p>
      {blocks.map(({ d, diff, receipts }) => (
        <Card key={d.id} title={`Divisi ${d.name.replace(/^Divisi /, "")}`} actions={canAdd(d.id) && <Modal trigger="+ Penerimaan" triggerClass="btn-primary btn-sm" title="Penerimaan hasil borongan" subtitle={d.name} wide><ReceiveForm divisionId={d.id} date={todayStr()} /></Modal>}>
          {diff.length === 0 ? <p className="text-sm text-slate-400">Belum ada tugas dengan barang hasil.</p> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Barang</th><th className="num">Setoran koordinator</th><th className="num">Diterima divisi</th><th className="num">Selisih</th><th className="num">Sisa di titik</th><th>Per titik</th></tr></thead>
                <tbody>{diff.map((r) => {
                  const pts = r.points.filter(pointFilter);
                  return (
                    <tr key={r.itemId}>
                      <td>{r.name}</td>
                      <td className="num">{f(r.setoran)}{r.setoranReject > 0 && <div className="text-xs text-slate-400">reject {f(r.setoranReject)}</div>}</td>
                      <td className="num">{f(r.diterima)}{r.rejectDiterima > 0 && <div className="text-xs text-rose-500">reject {f(r.rejectDiterima)}</div>}</td>
                      <td className="num">{r.selisih === 0 ? <Badge tone="green">✓ 0</Badge> : <Badge tone={r.selisih < 0 ? "amber" : "red"}>{r.selisih > 0 ? "+" : ""}{f(r.selisih)}</Badge>}</td>
                      <td className="num">{f(r.atPoint)}</td>
                      <td className="text-xs text-slate-600">{pts.map((p) => `${p.name}: setor ${f(p.setoran)} · terima ${f(p.diterima)}${p.selisih ? ` (${p.selisih > 0 ? "+" : ""}${f(p.selisih)})` : ""}`).join(" | ") || "—"}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          {receipts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">Riwayat penerimaan ({receipts.length})</summary>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {receipts.map((x) => (
                  <li key={x.id} className={`flex flex-wrap items-start justify-between gap-2 py-2 ${x.cancelledAt ? "opacity-50" : ""}`}>
                    <div className="min-w-0">
                      <p><span className="font-mono text-xs">{x.number}</span> · {fmtDay(x.date)} · {x.createdBy}{x.cancelledAt && <> · <Badge tone="gray">Dibatalkan {x.cancelBy}</Badge></>}</p>
                      <p className="text-xs text-slate-600">{x.lines.map((l) => `${l.item.name} ${f(Number(l.qty))}${Number(l.reject) ? ` (+reject ${f(Number(l.reject))})` : ""} dari ${l.point.name}`).join(" · ")}</p>
                    </div>
                    {!x.cancelledAt && (scope.all || scope.division?.captain || x.createdById === userId) && canAdd(d.id) && (
                      <ActionForm action={voidDivisionReceipt} confirm="Batalkan penerimaan ini? Barang kembali tercatat di titik."><input type="hidden" name="id" value={x.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Batalkan</Submit></ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}
