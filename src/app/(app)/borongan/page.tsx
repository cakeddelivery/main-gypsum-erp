import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { stockBalances } from "@/lib/stock";
import { recipeUnit } from "@/lib/unitcost";
import { BORONGAN_ROLE_LABEL, HANDOVER_LABEL, boronganScope, canPoint, payLines, resultShares } from "@/lib/borongan";
import { Badge, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { ItemLines } from "@/components/ItemLines";
import { ResultRows } from "./BoronganForms";
import { addResults, confirmHandover, payPoint, removePersonAction, removeResult, saveCoordinatorLogin, savePersonAction, saveTask, sendHandover, voidHandover } from "./actions";

export const metadata = { title: "Borongan" };

const TABS = [
  { key: "ringkasan", label: "Ringkasan" },
  { key: "serah", label: "Serah Terima" },
  { key: "hasil", label: "Setoran Hasil" },
  { key: "upah", label: "Upah" },
  { key: "orang", label: "Orang" },
  { key: "tugas", label: "Tugas & Tarif" },
];

export default async function BoronganPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePerm("borongan.view");
  const sp = await searchParams;
  const scope = await boronganScope(prisma, user);
  const manage = scope.all;
  const pointFilter = manage ? {} : { id: { in: scope.pointIds } };
  const resultFilter = manage ? {} : { pointId: { in: scope.pointIds } };
  const tabs = TABS.filter((t) => manage || !["tugas"].includes(t.key)).filter((t) => t.key !== "upah" || manage || user.can("borongan.pay"));
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : "ringkasan";

  const [points, people, tasks, items, banks, pending, balances] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { active: true, ...pointFilter }, include: { location: true }, orderBy: { code: "asc" } }),
    prisma.boronganPerson.findMany({ where: manage ? {} : { OR: [{ pointId: { in: scope.pointIds } }, { role: "DRIVER" }] }, include: { point: true, user: true }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.pieceTask.findMany({ include: { inputs: { include: { item: true } }, outputItem: true }, orderBy: { name: "asc" } }),
    prisma.item.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.boronganHandover.findMany({ where: { status: "DIKIRIM", ...resultFilter }, include: { lines: { include: { item: true } }, point: true, driver: true }, orderBy: { date: "asc" } }),
    stockBalances(prisma),
  ]);
  if (!manage && !points.length) {
    return (
      <div className="space-y-5">
        <PageHeader title="Borongan" />
        <Empty title="Akun Anda belum terhubung ke titik borongan" hint="Minta pengelola menghubungkan login Anda ke data koordinator." />
      </div>
    );
  }
  const itemById = new Map(items.map((i) => [i.id, i]));
  const stockAt = (locationId: string) => balances.filter((b) => b.locationId === locationId && Math.abs(b.qty) > 0.0005).map((b) => ({ ...b, item: itemById.get(b.itemId) })).filter((b) => b.item);
  const warehouseStock = new Map<string, number>();
  for (const b of balances) if (!points.some((p) => p.locationId === b.locationId)) warehouseStock.set(b.itemId, (warehouseStock.get(b.itemId) ?? 0) + b.qty);
  const activeTasks = tasks.filter((t) => t.active);
  const workers = people.filter((p) => p.role === "PEKERJA" && p.active && p.pointId);
  const drivers = people.filter((p) => p.role === "DRIVER" && p.active);
  const t = todayStr();
  const driverField = drivers.length > 0 && (
    <Field label="Driver"><select name="driverId" className="input" defaultValue={drivers[0].id}>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
  );

  const sendMaterial = manage && (
    <Modal trigger="+ Kirim Bahan" title="Kirim bahan ke titik lewat driver" wide>
      <ModalForm action={sendHandover} className="space-y-3">
        <input type="hidden" name="kind" value="KIRIM" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Titik tujuan"><select name="pointId" className="input">{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          {driverField}
          <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
        </div>
        <ItemLines items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, stock: Math.round((warehouseStock.get(i.id) ?? 0) * 1000) / 1000 }))} />
        <Field label="Catatan"><input name="note" className="input" /></Field>
        <p className="text-xs text-slate-500">Bahan keluar dari gudang begitu diserahkan ke driver, lalu masuk stok titik setelah koordinator menekan Terima.</p>
        <Submit>Serahkan Ke Driver</Submit>
      </ModalForm>
    </Modal>
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
  const resultForm = (
    <Modal trigger="+ Setoran Hasil" title="Catat setoran hasil kerja" wide>
      <ModalForm action={addResults} className="space-y-3">
        <ResultRows points={points.map((p) => ({ id: p.id, name: p.name }))} workers={workers.map((w) => ({ id: w.id, name: w.name, pointId: w.pointId! }))} tasks={activeTasks.map((x) => ({ id: x.id, name: x.name, workerRate: Number(x.workerRate), coordinatorRate: Number(x.coordinatorRate), driverRate: Number(x.driverRate) }))} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tanggal"><input type="date" name="date" defaultValue={t} className="input" /></Field>
          <Field label="Catatan"><input name="note" className="input" /></Field>
        </div>
        <p className="text-xs text-slate-500">Bahan sesuai resep tugas otomatis terpakai dari stok titik, dan barang hasil bertambah di stok titik.</p>
        <Submit>Simpan Setoran</Submit>
      </ModalForm>
    </Modal>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Borongan"
        subtitle={manage ? "Bahan dikirim lewat driver ke titik BMR & Mastrip, hasil disetor per pekerja, upah dibagi pekerja, koordinator, dan driver" : `Titik ${points.map((p) => p.name).join(", ")}`}
        actions={<div className="flex flex-wrap gap-2">{sendMaterial}{resultForm}{sendBack}</div>}
      />
      <Tabs current={tab} tabs={tabs.map((x) => ({ ...x, href: `?tab=${x.key}`, count: x.key === "serah" ? pending.length || undefined : undefined }))} />

      {tab === "ringkasan" && (
        <>
          {pending.length > 0 && <PendingList pending={pending} scope={scope} />}
          <div className="grid gap-5 lg:grid-cols-2">
            {points.map((p) => <PointCard key={p.id} point={p} stock={stockAt(p.locationId)} people={people.filter((x) => x.pointId === p.id && x.active)} />)}
          </div>
        </>
      )}
      {tab === "serah" && <HandoverTab scope={scope} pending={pending} filter={resultFilter} />}
      {tab === "hasil" && <ResultsTab filter={resultFilter} />}
      {tab === "upah" && <WagesTab points={points} banks={banks} canPay={user.can("borongan.pay")} />}
      {tab === "orang" && <PeopleTab people={people} points={points} manage={manage} canLogin={manage} />}
      {tab === "tugas" && manage && <TasksTab tasks={tasks} items={items} />}
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
          const canReceive = h.kind === "KIRIM" ? canPoint(scope, h.pointId) : scope.all;
          const canCancel = h.kind === "KIRIM" ? scope.all : canPoint(scope, h.pointId);
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
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Stok di titik</p>
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

async function ResultsTab({ filter }: { filter: object }) {
  const rows = await prisma.boronganResult.findMany({ where: filter, include: { worker: true, task: true, point: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200 });
  return (
    <Card title="Setoran hasil kerja">
      {rows.length === 0 ? <Empty title="Belum ada setoran" /> : (
        <Paged><table className="tbl">
          <thead><tr><th>Tanggal</th><th>Titik</th><th>Pekerja</th><th>Tugas</th><th className="num">Pcs</th><th className="num">Upah Pekerja</th><th className="num">Total Budget</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const s = resultShares(r.qty, { workerRate: Number(r.workerRate), coordinatorRate: Number(r.coordinatorRate), driverRate: Number(r.driverRate) });
            return (
              <tr key={r.id}>
                <td>{fmtDay(r.date)}</td><td>{r.point.name}</td><td>{r.worker.name}</td><td>{r.task.name}</td>
                <td className="num">{r.qty.toLocaleString("id-ID")}</td><td className="num">{idr(s.worker)}</td><td className="num">{idr(s.total)}</td>
                <td>{r.settlementId ? <Badge tone="green">Dibayar</Badge> : <Badge tone="amber">Belum Dibayar</Badge>}</td>
                <td>{!r.settlementId && <ActionForm action={removeResult} confirm="Hapus setoran ini? Stok bahan & hasil dikembalikan."><input type="hidden" name="id" value={r.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>}</td>
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
  return (
    <div className="space-y-5">
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
                <span>{fmtDay(h.date)} · {h.point.name} · s.d. {fmtDay(h.upTo)}</span>
                <span className="flex items-center gap-2"><b className="tabular-nums">{idr(h.total)}</b>
                  <Modal trigger="Rincian" triggerClass="btn-secondary btn-sm" title={`Rincian ${h.number}`}><PayTable lines={payLines(h.results)} /></Modal>
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

function PersonForm({ p, points, manage }: { p?: PersonRow; points: { id: string; name: string }[]; manage: boolean }) {
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
      {p && <Field label="Status"><select name="active" defaultValue={p.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Field label="Catatan"><input name="note" defaultValue={p?.note ?? ""} className="input" /></Field>
      <Submit>Simpan</Submit>
    </ModalForm>
  );
}

function PeopleTab({ people, points, manage, canLogin }: { people: PersonRow[]; points: { id: string; name: string }[]; manage: boolean; canLogin: boolean }) {
  const groups = [...points.map((p) => ({ key: p.id, title: `Titik ${p.name}`, rows: people.filter((x) => x.pointId === p.id) })), { key: "drv", title: "Driver", rows: people.filter((x) => x.role === "DRIVER") }];
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Modal trigger={manage ? "+ Orang" : "+ Pekerja"} title={manage ? "Tambah orang borongan" : "Tambah pekerja"}><PersonForm points={points} manage={manage} /></Modal>
      </div>
      <p className="text-sm text-slate-500">Pekerja borongan adalah tetangga, bukan karyawan: tidak masuk absensi, gaji bulanan, atau kasbon.</p>
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.key} title={g.title}>
            {g.rows.length === 0 ? <p className="text-sm text-slate-400">Belum ada</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {g.rows.map((p) => {
                  const editable = manage || p.role === "PEKERJA";
                  return (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className={p.active ? "" : "text-slate-400 line-through"}>
                        {p.name} <Badge tone={p.role === "KOORDINATOR" ? "blue" : p.role === "DRIVER" ? "amber" : "gray"}>{BORONGAN_ROLE_LABEL[p.role]}</Badge>
                        {p.user && <span className="ml-1 text-xs text-slate-500">login: {p.user.username}</span>}
                      </span>
                      {editable && (
                        <span className="flex gap-2">
                          {canLogin && p.role === "KOORDINATOR" && (
                            <Modal trigger={p.user ? "Login" : "Buat Login"} triggerClass="btn-secondary btn-sm" title={`Login koordinator ${p.name}`}>
                              <ModalForm action={saveCoordinatorLogin} className="space-y-3">
                                <input type="hidden" name="personId" value={p.id} />
                                <Field label="Username"><input name="username" defaultValue={p.user?.username ?? ""} className="input" autoComplete="off" required /></Field>
                                <Field label={p.user ? "Password baru (kosongkan bila tetap)" : "Password"}><input name="password" type="password" className="input" autoComplete="new-password" minLength={8} /></Field>
                                <p className="text-xs text-slate-500">Koordinator hanya melihat titiknya: menerima bahan, mencatat setoran hasil, mengirim hasil, dan mengelola pekerja.</p>
                                <Submit>Simpan</Submit>
                              </ModalForm>
                            </Modal>
                          )}
                          <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${p.name}`}><PersonForm p={p} points={points} manage={manage} /></Modal>
                          {p.active && <ActionForm action={removePersonAction} confirm={`Hapus ${p.name}? Yang sudah punya riwayat setoran hanya dinonaktifkan.`}><input type="hidden" name="id" value={p.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>}
                        </span>
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

function TaskForm({ task, items }: { task?: TaskRow; items: ItemRow[] }) {
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
      <Field label="Barang hasil (masuk stok titik)"><select name="outputItemId" defaultValue={task?.outputItemId ?? ""} className="input"><option value="">— tanpa stok hasil —</option>{items.filter((i) => i.type !== "BAHAN_BAKU").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
      <div>
        <span className="label">Bahan terpakai per 1 pcs hasil</span>
        <ItemLines items={items.map((i) => ({ id: i.id, name: i.name, unit: recipeUnit(i) }))} initial={task?.inputs.map((x) => ({ itemId: x.itemId, qty: Number(x.qty) })) ?? []} qtyLabel="Per pcs" emptyLabel="— pilih bahan —" />
      </div>
      {task && <Field label="Status"><select name="active" defaultValue={task.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );
}

function TasksTab({ tasks, items }: { tasks: TaskRow[]; items: ItemRow[] }) {
  return (
    <Card title="Tugas & pembagian budget per pcs" actions={<Modal trigger="+ Tugas" triggerClass="btn-primary btn-sm" title="Tugas borongan baru" wide><TaskForm items={items} /></Modal>}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Tugas</th><th className="num">Budget</th><th className="num">Pekerja</th><th className="num">Koordinator</th><th className="num">Driver</th><th>Hasil & Bahan</th><th /></tr></thead>
          <tbody>{tasks.map((x) => (
            <tr key={x.id} className={x.active ? "" : "opacity-50"}>
              <td>{x.name}</td><td className="num">{idr(x.ratePerPcs)}</td><td className="num">{idr(x.workerRate)}</td><td className="num">{idr(x.coordinatorRate)}</td><td className="num">{idr(x.driverRate)}</td>
              <td className="text-xs">{x.outputItem ? `→ ${x.outputItem.name}` : "—"}{x.inputs.length > 0 && <><br />{x.inputs.map((i) => `${i.item.name} ${Number(i.qty).toLocaleString("id-ID")} ${recipeUnit(i.item)}`).join(", ")}</>}</td>
              <td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${x.name}`} wide><TaskForm task={x} items={items} /></Modal></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}

