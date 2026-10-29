import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, fmtDateTime, fmtDay, todayStr } from "@/lib/time";
import { ATT_LABEL } from "@/lib/attendance";
import { Badge, Card, Empty, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { GeoSubmit, UseMyLocation } from "@/components/GeoFields";
import { checkIn, checkOut, deleteWorkSite, saveAttendance, saveSchedule, saveWorkSite, validateAttendance } from "./actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Absensi" };
const TONE = { HADIR: "green", TERLAMBAT: "amber", IZIN: "blue", SAKIT: "purple", ALPA: "red", LIBUR: "gray" } as const;

export default async function AbsensiPage({ searchParams }: { searchParams: Promise<{ tab?: string; date?: string }> }) {
  const user = await requirePerm("attendance.view", "attendance.self");
  const sp = await searchParams;
  const today = todayStr();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const canManage = user.can("attendance.manage");
  const canLocation = user.can("attendance.location");
  const tabs = [
    ...(canManage
      ? [{ key: "harian", label: "Harian", href: `/absensi?tab=harian&date=${date}` }, { key: "jadwal", label: "Jadwal shift", href: `/absensi?tab=jadwal&date=${date}` }, { key: "validasi", label: "Validasi", href: "/absensi?tab=validasi" }]
      : []),
    ...(canLocation ? [{ key: "lokasi", label: "Lokasi kerja", href: "/absensi?tab=lokasi" }] : []),
  ];
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : (tabs[0]?.key ?? "saya");
  const divFilter = user.role === "KAPTEN_DIVISI" && user.divisionId ? { divisionId: user.divisionId } : {};
  const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const sites = await prisma.workSite.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const siteNote = sites.length > 0 && (
    <p className="mt-2 text-xs text-slate-500">Absen hanya bisa di lokasi kerja: {sites.map((x) => `${x.name} (radius ${x.radiusM} m)`).join(", ")}. Nyalakan GPS & izinkan akses lokasi.</p>
  );

  const self = user.employeeId
    ? await Promise.all([
        prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(today) } }, include: { shift: true } }),
        prisma.attendance.findMany({ where: { employeeId: user.employeeId }, include: { shift: true }, orderBy: { date: "desc" }, take: 14 }),
      ])
    : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Absensi" subtitle="Absensi berbasis shift dengan toleransi keterlambatan" />
      {self && user.can("attendance.self") && (
        <Card title={`Absensi saya · ${fmtDay(dateOnly(today))}`}>
          {self[0] ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <Badge tone={TONE[self[0].status]}>{ATT_LABEL[self[0].status]}</Badge> <span className="ml-1">{self[0].shift.name}</span>
                <div className="mt-1 text-slate-500">Masuk {fmtDateTime(self[0].checkIn)}{self[0].lateMinutes > 0 && ` · terlambat ${self[0].lateMinutes} menit`}{self[0].checkOut && ` · Pulang ${fmtDateTime(self[0].checkOut)}`}</div>
              </div>
              {!self[0].checkOut && self[0].checkIn && (
                <ActionForm action={checkOut}><GeoSubmit required={sites.length > 0} className="btn-secondary">Absen pulang</GeoSubmit></ActionForm>
              )}
              {!self[0].checkOut && self[0].checkIn && siteNote}
            </div>
          ) : (
            <ActionForm action={checkIn} className="flex flex-wrap items-end gap-3">
              <GeoSubmit required={sites.length > 0} className="btn-primary px-6 py-3 text-base">Absen masuk sekarang</GeoSubmit>
              <div className="w-full">{siteNote}</div>
            </ActionForm>
          )}
          {self[1].length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100 text-sm">
              {self[1].map((a) => (
                <li key={a.id} className="flex justify-between py-1.5"><span>{fmtDay(a.date)} · {a.shift.name}</span><span className="flex items-center gap-2">{!a.validated && <span className="text-xs text-slate-400">belum divalidasi</span>}<Badge tone={TONE[a.status]}>{ATT_LABEL[a.status]}</Badge></span></li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {tabs.length > 0 && (
        <>
          <Tabs current={tab} tabs={tabs} />
          {canManage && tab === "harian" && <Daily date={date} divFilter={divFilter} shifts={shifts} />}
          {canManage && tab === "jadwal" && <Schedule date={date} divFilter={divFilter} shifts={shifts} />}
          {canManage && tab === "validasi" && <Validation divFilter={divFilter} />}
          {canLocation && tab === "lokasi" && <WorkSites />}
        </>
      )}
    </div>
  );
}

type Shift = { id: string; name: string; startTime: string };

async function Daily({ date, divFilter, shifts }: { date: string; divFilter: object; shifts: Shift[] }) {
  const employees = await prisma.employee.findMany({ where: { status: { not: "NONAKTIF" }, ...divFilter }, include: { division: true }, orderBy: [{ divisionId: "asc" }, { name: "asc" }] });
  const [att, sched] = await Promise.all([
    prisma.attendance.findMany({ where: { date: dateOnly(date), employeeId: { in: employees.map((e) => e.id) } }, include: { shift: true } }),
    prisma.shiftSchedule.findMany({ where: { date: dateOnly(date), employeeId: { in: employees.map((e) => e.id) } }, include: { shift: true } }),
  ]);
  return (
    <>
      <FilterBar><input type="hidden" name="tab" value="harian" /><Field label="Tanggal"><input type="date" name="date" defaultValue={date} className="input" /></Field></FilterBar>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Karyawan</th><th>Divisi</th><th>Jadwal</th><th>Status</th><th>Masuk</th><th>Pulang</th><th>Validasi</th><th /></tr></thead>
          <tbody>
            {employees.map((e) => {
              const a = att.find((x) => x.employeeId === e.id);
              const s = sched.find((x) => x.employeeId === e.id);
              return (
                <tr key={e.id}>
                  <td>{e.name}</td><td>{e.division.name}</td><td>{s?.shift.name ?? <span className="text-slate-400">—</span>}</td>
                  <td>{a ? <Badge tone={TONE[a.status]}>{ATT_LABEL[a.status]}{a.lateMinutes > 0 && ` ${a.lateMinutes}m`}</Badge> : <span className="text-slate-400">Belum ada</span>}</td>
                  <td>{a?.checkIn ? fmtDateTime(a.checkIn).slice(-9) : "-"}{a && <GeoLink lat={a.checkInLat} lng={a.checkInLng} distance={a.checkInDistance} />}</td>
                  <td>{a?.checkOut ? fmtDateTime(a.checkOut).slice(-9) : "-"}{a && <GeoLink lat={a.checkOutLat} lng={a.checkOutLng} distance={a.checkOutDistance} />}</td>
                  <td>{a ? (a.validated ? <Badge tone="green">✓ {a.validatedBy}</Badge> : <Badge tone="amber">Belum</Badge>) : "-"}</td>
                  <td>
                    <Modal trigger="Atur" triggerClass="btn-secondary btn-sm" title={`Absensi ${e.name}`}>
                      <ModalForm action={saveAttendance} className="grid grid-cols-2 gap-3">
                        <input type="hidden" name="employeeId" value={e.id} /><input type="hidden" name="date" value={date} />
                        <label><span className="label">Shift</span><select name="shiftId" defaultValue={a?.shiftId ?? s?.shiftId} className="input">{shifts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                        <label><span className="label">Status</span><select name="status" defaultValue={a?.status ?? "HADIR"} className="input">{Object.entries(ATT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                        <label><span className="label">Jam masuk (WIB)</span><input type="time" name="checkIn" className="input" /></label>
                        <label><span className="label">Catatan</span><input name="note" defaultValue={a?.note ?? ""} className="input" /></label>
                        <p className="col-span-2 text-xs text-slate-500">Status hadir/terlambat dihitung otomatis dari jam masuk & toleransi shift.</p>
                        <div className="col-span-2 flex justify-end"><Submit>Simpan & validasi</Submit></div>
                      </ModalForm>
                    </Modal>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></Paged>
      </div>
    </>
  );
}

async function Schedule({ date, divFilter, shifts }: { date: string; divFilter: object; shifts: Shift[] }) {
  const dow = (dateOnly(date).getUTCDay() + 6) % 7;
  const start = addDays(date, -dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const employees = await prisma.employee.findMany({ where: { status: { not: "NONAKTIF" }, ...divFilter }, orderBy: { name: "asc" } });
  const sched = await prisma.shiftSchedule.findMany({ where: { date: { gte: dateOnly(days[0]), lte: dateOnly(days[6]) }, employeeId: { in: employees.map((e) => e.id) } }, include: { shift: true } });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn-secondary btn-sm" href={`/absensi?tab=jadwal&date=${addDays(start, -7)}`}>← Minggu lalu</a>
        <span className="text-sm font-medium">{fmtDay(dateOnly(days[0]))} – {fmtDay(dateOnly(days[6]))}</span>
        <a className="btn-secondary btn-sm" href={`/absensi?tab=jadwal&date=${addDays(start, 7)}`}>Minggu depan →</a>
        <div className="ml-auto">
          <Modal trigger="Atur jadwal" title="Atur jadwal shift">
            <ModalForm action={saveSchedule} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label><span className="label">Dari</span><input type="date" name="from" defaultValue={days[0]} className="input" /></label>
                <label><span className="label">Sampai</span><input type="date" name="to" defaultValue={days[5]} className="input" /></label>
              </div>
              <label className="block"><span className="label">Shift</span><select name="shiftId" className="input">{shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime})</option>)}</select></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="skipSunday" defaultChecked /> Lewati hari Minggu</label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {employees.map((e) => <label key={e.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="employeeIds" value={e.id} /> {e.name}</label>)}
              </div>
              <Submit>Simpan jadwal</Submit>
            </ModalForm>
          </Modal>
        </div>
      </div>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Karyawan</th>{days.map((d) => <th key={d}>{fmtDay(dateOnly(d)).split(",")[0]} {d.slice(8)}</th>)}</tr></thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}><td>{e.name}</td>{days.map((d) => { const s = sched.find((x) => x.employeeId === e.id && x.date.toISOString().slice(0, 10) === d); return <td key={d}>{s ? <Badge tone={s.shift.code === "S1" ? "blue" : "purple"}>{s.shift.name}</Badge> : <span className="text-slate-300">—</span>}</td>; })}</tr>
            ))}
          </tbody>
        </table></Paged>
      </div>
    </div>
  );
}

async function Validation({ divFilter }: { divFilter: object }) {
  const rows = await prisma.attendance.findMany({ where: { validated: false, employee: divFilter }, include: { employee: true, shift: true }, orderBy: { date: "desc" }, take: 200 });
  if (!rows.length) return <Empty title="Semua absensi sudah divalidasi" />;
  return (
    <ActionForm action={validateAttendance}>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th /><th>Tanggal</th><th>Karyawan</th><th>Shift</th><th>Status</th><th>Masuk</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}><td><input type="checkbox" name="ids" value={a.id} defaultChecked className="h-4 w-4" /></td><td>{fmtDay(a.date)}</td><td>{a.employee.name}</td><td>{a.shift.name}</td><td><Badge tone={TONE[a.status]}>{ATT_LABEL[a.status]}{a.lateMinutes > 0 && ` ${a.lateMinutes}m`}</Badge></td><td>{fmtDateTime(a.checkIn)}</td></tr>
            ))}
          </tbody>
        </table></Paged>
      </div>
      <div className="mt-3"><Submit>Validasi yang dipilih</Submit></div>
    </ActionForm>
  );
}

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/** Tautan peta koordinat absen + jarak ke titik lokasi kerja */
function GeoLink({ lat, lng, distance }: { lat: number | null; lng: number | null; distance: number | null }) {
  if (lat == null || lng == null) return null;
  return (
    <a href={mapsUrl(lat, lng)} target="_blank" rel="noreferrer" className="ml-1 text-xs text-blue-600 underline" title="Lihat di peta">
      📍{distance != null ? ` ${distance} m` : ""}
    </a>
  );
}

function SiteFields({ site }: { site?: { name: string; latitude: number; longitude: number; radiusM: number } }) {
  return (
    <>
      <label className="col-span-2"><span className="label">Nama lokasi</span><input name="name" required defaultValue={site?.name} placeholder="mis. Pabrik Lamongan" className="input" /></label>
      <label><span className="label">Latitude</span><input name="latitude" required inputMode="decimal" defaultValue={site?.latitude} placeholder="-7.1167" className="input" /></label>
      <label><span className="label">Longitude</span><input name="longitude" required inputMode="decimal" defaultValue={site?.longitude} placeholder="112.4167" className="input" /></label>
      <UseMyLocation />
      <label><span className="label">Radius (meter)</span><input name="radiusM" type="number" min={20} max={5000} required defaultValue={site?.radiusM ?? 100} className="input" /></label>
    </>
  );
}

async function WorkSites() {
  const sites = await prisma.workSite.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { _count: { select: { checkIns: true } } } });
  return (
    <div className="space-y-4">
      <Card title="Lokasi kerja untuk absen">
        <p className="text-sm text-slate-600">
          Karyawan hanya bisa absen masuk & pulang bila GPS HP-nya berada di dalam radius salah satu lokasi aktif. Selama belum ada lokasi aktif, absen tetap bisa dari mana saja (koordinat tetap dicatat).
          Cara termudah: buka halaman ini dari HP saat berada di pabrik, lalu tekan <b>Pakai lokasi saya sekarang</b>. Koordinat juga bisa disalin dari Google Maps (tekan lama titik di peta).
        </p>
        <div className="mt-3">
          <Modal trigger="Tambah lokasi" title="Tambah lokasi kerja">
            <ModalForm action={saveWorkSite} className="grid grid-cols-2 gap-3">
              <SiteFields />
              <div className="col-span-2 flex justify-end"><Submit>Simpan lokasi</Submit></div>
            </ModalForm>
          </Modal>
        </div>
      </Card>
      {sites.length === 0 ? (
        <Empty title="Belum ada lokasi kerja" />
      ) : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Lokasi</th><th>Koordinat</th><th>Radius</th><th>Status</th><th>Absen tercatat</th><th /></tr></thead>
            <tbody>
              {sites.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td><a href={mapsUrl(x.latitude, x.longitude)} target="_blank" rel="noreferrer" className="text-blue-600 underline">{x.latitude.toFixed(6)}, {x.longitude.toFixed(6)}</a></td>
                  <td>{x.radiusM} m</td>
                  <td>{x.active ? <Badge tone="green">Aktif</Badge> : <Badge tone="gray">Nonaktif</Badge>}</td>
                  <td>{x._count.checkIns}</td>
                  <td><div className="flex gap-2">
                    <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${x.name}`}>
                      <ModalForm action={saveWorkSite} className="grid grid-cols-2 gap-3">
                        <input type="hidden" name="id" value={x.id} />
                        <SiteFields site={x} />
                        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>
                        <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
                      </ModalForm>
                    </Modal>
                    <ActionForm action={deleteWorkSite} confirm={`Hapus lokasi ${x.name}?`}>
                      <input type="hidden" name="id" value={x.id} />
                      <Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit>
                    </ActionForm>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
