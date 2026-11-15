import { AUTO_NOTE, SHIFT_NOTE_PREFIX } from "@/lib/attendanceRules";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addDays, dateOnly, dateStr, fmtDateTime, fmtDay, todayStr } from "@/lib/time";
import { ATT_LABEL } from "@/lib/attendance";
import { fmtMinutes, lateRecap } from "@/lib/lateRecap";
import { Badge, Card, Empty, FilterBar, Field, PageHeader, Tabs } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { UseMyLocation } from "@/components/GeoFields";
import { checkIn, checkOut, deleteWorkSite, saveAttendance, correctAttendance, saveScheduleCells, saveWorkSite } from "./actions";
import { Paged } from "@/components/Paged";
import { canDecideLeave } from "@/lib/leave";
import { nearestShift } from "@/lib/attendance";
import { divisionReportSent } from "@/lib/attendanceSelf";
import { AbsenToday } from "./AbsenToday";
import { scheduleGroups } from "@/lib/scheduleGroups";
import { cellKey, cellOf, type Cell } from "@/lib/scheduleEdit";
import { ScheduleTable } from "./ScheduleTable";
import { IzinSakit, Riwayat } from "./SelfTabs";

export const metadata = { title: "Absensi" };
const TONE = { HADIR: "green", TERLAMBAT: "amber", IZIN: "blue", SAKIT: "purple", ALPA: "red", LIBUR: "gray" } as const;

export default async function AbsensiPage({ searchParams }: { searchParams: Promise<{ tab?: string; date?: string; month?: string }> }) {
  const user = await requirePerm("attendance.view", "attendance.self");
  const sp = await searchParams;
  const today = todayStr();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const canManage = user.can("attendance.manage");
  const canLocation = user.can("attendance.location");
  const isSelf = !!user.employeeId && user.can("attendance.self");
  const approver = canDecideLeave(user.role);
  const pendingLeave = approver ? await prisma.leaveRequest.count({ where: { status: "MENUNGGU" } }) : undefined;
  const tabs = [
    ...(isSelf ? [{ key: "saya", label: "Hari ini", href: "/absensi?tab=saya" }, { key: "riwayat", label: "Riwayat", href: "/absensi?tab=riwayat" }] : []),
    ...(isSelf || approver ? [{ key: "izin", label: "Izin & Sakit", href: "/absensi?tab=izin", count: pendingLeave || undefined }] : []),
    ...(canManage
      ? [{ key: "harian", label: "Harian", href: `/absensi?tab=harian&date=${date}` }, { key: "jadwal", label: "Jadwal shift", href: `/absensi?tab=jadwal&date=${date}` }, { key: "koreksi", label: "Alpa & koreksi", href: "/absensi?tab=koreksi" }, { key: "telat", label: "Rekap telat", href: `/absensi?tab=telat&date=${date}` }]
      : []),
    ...(canLocation ? [{ key: "lokasi", label: "Lokasi kerja", href: "/absensi?tab=lokasi" }] : []),
  ];
  // Tautan lama ?tab=validasi diarahkan ke tab pengganti
  const want = sp.tab === "validasi" ? "koreksi" : sp.tab;
  const tab = tabs.some((t) => t.key === want) ? want! : (tabs[0]?.key ?? "saya");
  const divFilter = user.role === "KAPTEN_DIVISI" && user.divisionId ? { divisionId: user.divisionId } : {};
  const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : today.slice(0, 7);

  return (
    <div className={isSelf && tab === "saya" ? "space-y-3" : "space-y-5"}>
      {!(isSelf && tab === "saya") && <PageHeader title="Absensi" subtitle={isSelf ? undefined : "Absensi berbasis shift dengan toleransi keterlambatan"} />}
      {tabs.length > 1 && <Tabs current={tab} tabs={tabs} />}
      {isSelf && tab === "saya" && <Today user={user} shifts={shifts} />}
      {isSelf && tab === "riwayat" && <Riwayat employeeId={user.employeeId!} month={month} />}
      {tab === "izin" && <IzinSakit user={user} />}
      {canManage && tab === "harian" && <Daily date={date} divFilter={divFilter} shifts={shifts} />}
      {canManage && tab === "jadwal" && <Schedule date={date} divFilter={divFilter} shifts={shifts} />}
      {canManage && tab === "koreksi" && <Corrections divFilter={divFilter} canCorrect={user.role === "SUPERVISOR" || user.role === "OWNER"} shifts={shifts} />}
      {canManage && tab === "telat" && <LateTab date={date} month={sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : date.slice(0, 7)} divisionId={user.role === "KAPTEN_DIVISI" ? user.divisionId : null} />}
      {canLocation && tab === "lokasi" && <WorkSites />}
    </div>
  );
}

/** Tab "Hari ini": data absen sendiri untuk tampilan varian A */
async function Today({ user, shifts }: { user: { name: string; employeeId: string | null; photoUrl: string | null }; shifts: (Shift & { endTime: string; toleranceMinutes: number })[] }) {
  const today = todayStr();
  const d = dateOnly(today);
  const [att, sched, sites] = await Promise.all([
    prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId!, date: d } }, include: { shift: true } }),
    prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: user.employeeId!, date: d } }, include: { shift: true } }),
    prisma.workSite.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, latitude: true, longitude: true, radiusM: true } }),
  ]);
  const shift = att?.shift ?? sched?.shift ?? nearestShift(shifts, new Date());
  const report = att?.checkIn && !att.checkOut ? await divisionReportSent(user.employeeId!, att.date, att.shiftId) : null;
  return (
    <AbsenToday
      name={user.name}
      photoUrl={user.photoUrl}
      shift={shift ? { name: shift.name, startTime: shift.startTime, endTime: shift.endTime, toleranceMinutes: shift.toleranceMinutes } : null}
      sites={sites}
      att={att ? { status: att.status, checkIn: att.checkIn?.toISOString() ?? null, checkOut: att.checkOut?.toISOString() ?? null, lateMinutes: att.lateMinutes, note: att.note } : null}
      report={report}
      checkIn={checkIn}
      checkOut={checkOut}
    />
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
                  <td>{a?.checkOut ? fmtDateTime(a.checkOut).slice(-9) : "-"}{a && <GeoLink lat={a.checkOutLat} lng={a.checkOutLng} distance={a.checkOutDistance} />}{a?.reportMissing && <div><Badge tone="red">Pulang sebelum laporan shift terkirim</Badge></div>}</td>
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

async function Schedule({ date, divFilter }: { date: string; divFilter: object; shifts: Shift[] }) {
  const dow = (dateOnly(date).getUTCDay() + 6) % 7;
  const start = addDays(date, -dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const rows = await prisma.employee.findMany({ where: { status: { not: "NONAKTIF" }, ...divFilter }, include: { division: true, user: { select: { role: true } } }, orderBy: { name: "asc" } });
  const groups = scheduleGroups(rows.map((e) => ({ ...e, role: e.user?.role ?? null })));
  const [sched, activeShifts] = await Promise.all([
    prisma.shiftSchedule.findMany({ where: { date: { gte: dateOnly(days[0]), lte: dateOnly(days[6]) }, employeeId: { in: rows.map((e) => e.id) } } }),
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true } }),
  ]);
  // Divisi 2 shift (mis. Cetak, Oven) memakai saklar S1 · — · S2; lainnya centang masuk/libur
  const shiftDivOf = new Map(rows.map((e) => [e.id, e.user?.role !== "SUPERVISOR" && e.division.shiftCount >= 2]));
  const saved: Record<string, Cell> = {};
  for (const s of sched) saved[cellKey(s.employeeId, dateStr(s.date))] = cellOf(activeShifts.findIndex((x) => x.id === s.shiftId), !!shiftDivOf.get(s.employeeId));
  const view = groups.map((g) => ({ key: g.key, name: g.name, shiftDiv: g.rows.length > 0 && g.rows.every((r) => shiftDivOf.get(r.id)), rows: g.rows.map((r) => ({ id: r.id, name: r.name })) }));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn-secondary btn-sm" href={`/absensi?tab=jadwal&date=${addDays(start, -7)}`}>← Minggu lalu</a>
        <span className="text-sm font-medium">{fmtDay(dateOnly(days[0]))} – {fmtDay(dateOnly(days[6]))}</span>
        <a className="btn-secondary btn-sm" href={`/absensi?tab=jadwal&date=${addDays(start, 7)}`}>Minggu depan →</a>
      </div>
      <ScheduleTable
        days={days.map((d) => ({ date: d, label: `${fmtDay(dateOnly(d)).split(",")[0]} ${d.slice(8)}` }))}
        groups={view}
        saved={saved}
        canEdit
        save={saveScheduleCells}
      />
    </div>
  );
}

/**
 * Riwayat status otomatis (read-only): Alpa, Libur sesuai jadwal, dan shift yang disesuaikan otomatis, 30 hari terakhir.
 * Supervisor/Owner bisa mengoreksi satu baris dengan alasan wajib (tercatat di audit log).
 */
async function Corrections({ divFilter, canCorrect }: { divFilter: object; canCorrect: boolean; shifts: Shift[] }) {
  const today = todayStr();
  const rows = await prisma.attendance.findMany({
    where: { employee: divFilter, date: { gte: dateOnly(addDays(today, -30)), lt: dateOnly(today) }, OR: [{ status: { in: ["ALPA", "LIBUR"] } }, { note: { startsWith: SHIFT_NOTE_PREFIX } }, { note: { startsWith: "Koreksi " } }] },
    include: { employee: { include: { division: true } }, shift: true },
    orderBy: [{ date: "desc" }, { employee: { name: "asc" } }],
    take: 300,
  });
  if (!rows.length) return <Empty title="Tidak ada Alpa atau koreksi 30 hari terakhir" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Status dihitung otomatis setiap pagi dari jadwal & absen: dijadwalkan masuk tanpa absen = <b>Alpa</b>, tidak dicentang di jadwal = <b>Libur</b>, absen di shift lain (Cetak/Oven) = shift disesuaikan. Tidak perlu divalidasi manual.{canCorrect ? " Bila keliru (mis. lupa absen), tekan Koreksi." : ""}</p>
      <div className="card overflow-hidden">
        <Paged>
          <table className="tbl tbl-grid w-full">
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="!whitespace-normal">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words font-medium text-slate-900">{a.employee.name}</span>
                      <Badge tone={TONE[a.status]}>{a.status === "TERLAMBAT" ? `Telat ${a.lateMinutes} mnt` : ATT_LABEL[a.status]}</Badge>
                    </div>
                    <div className="mt-0.5 break-words text-xs text-slate-500">{fmtDay(a.date)} · {a.employee.division.name} · {a.shift.name}{a.checkIn ? ` · masuk ${fmtDateTime(a.checkIn).slice(-9)}` : ""}</div>
                    {a.note && <div className="mt-0.5 break-words text-xs text-slate-600">{a.note === AUTO_NOTE ? "Tidak absen (otomatis)" : a.note}</div>}
                    {canCorrect && (
                      <div className="mt-2">
                        <Modal trigger="Koreksi" triggerClass="btn-secondary btn-sm" title={`Koreksi absensi ${a.employee.name}`} subtitle={fmtDay(a.date)}>
                          <ModalForm action={correctAttendance} className="space-y-3">
                            <input type="hidden" name="employeeId" value={a.employeeId} /><input type="hidden" name="date" value={dateStr(a.date)} />
                            <Field label="Status sebenarnya">
                              <select name="status" defaultValue={a.status === "ALPA" ? "HADIR" : a.status === "TERLAMBAT" ? "HADIR" : a.status} className="input">
                                <option value="HADIR">Hadir (mis. lupa absen)</option>
                                <option value="IZIN">Izin</option>
                                <option value="SAKIT">Sakit</option>
                                <option value="LIBUR">Libur</option>
                                <option value="ALPA">Alpa</option>
                              </select>
                            </Field>
                            <Field label="Jam masuk (bila hadir)" hint="Kosong = jam mulai shift"><input type="time" name="checkIn" className="input" /></Field>
                            <Field label="Alasan koreksi (wajib)"><textarea name="reason" required minLength={3} rows={2} className="input" placeholder="Mis. lupa absen, hadir dikonfirmasi Kapten" /></Field>
                            <Submit>Simpan koreksi</Submit>
                          </ModalForm>
                        </Modal>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Paged>
      </div>
    </div>
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
      <label><span className="label">Radius (meter)</span><input name="radiusM" type="number" inputMode="numeric" min={20} max={5000} required defaultValue={site?.radiusM ?? 100} className="input" /></label>
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

/** Rekap telat harian (tanggal dipilih) & bulanan per orang. Hanya rekap: tidak memotong gaji. */
async function LateTab({ date, month, divisionId }: { date: string; month: string; divisionId: string | null }) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const [daily, monthly] = await Promise.all([lateRecap(date, date, divisionId), lateRecap(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`, divisionId)]);
  const total = monthly.reduce((a, r) => ({ count: a.count + r.count, minutes: a.minutes + r.minutes }), { count: 0, minutes: 0 });
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">Telat = absen masuk lewat toleransi shift. Hanya direkap (juga tampil di slip gaji), <b>tidak memotong gaji</b>.</p>
      <Card title={`Telat hari ini · ${fmtDay(dateOnly(date))}`}>
        <FilterBar><input type="hidden" name="tab" value="telat" /><input type="hidden" name="month" value={month} /><Field label="Tanggal"><input type="date" name="date" defaultValue={date} className="input" /></Field></FilterBar>
        {daily.length === 0 ? <p className="text-sm text-slate-400">Tidak ada yang telat</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Karyawan</th><th>Divisi</th><th className="num">Telat</th></tr></thead>
            <tbody>{daily.map((r) => <tr key={r.employeeId}><td>{r.name}</td><td>{r.division}</td><td className="num">{fmtMinutes(r.minutes)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={`Rekap telat bulan ${month} · ${total.count}× · ${fmtMinutes(total.minutes)}`}>
        <FilterBar><input type="hidden" name="tab" value="telat" /><input type="hidden" name="date" value={date} /><Field label="Bulan"><input type="month" name="month" defaultValue={month} className="input" /></Field></FilterBar>
        {monthly.length === 0 ? <p className="text-sm text-slate-400">Tidak ada yang telat bulan ini</p> : (
          <div className="table-wrap"><Paged><table className="tbl">
            <thead><tr><th>Karyawan</th><th>Divisi</th><th className="num">Berapa kali</th><th className="num">Total menit</th><th>Tanggal</th></tr></thead>
            <tbody>{monthly.map((r) => (
              <tr key={r.employeeId}><td>{r.name}</td><td>{r.division}</td><td className="num">{r.count}×</td><td className="num">{fmtMinutes(r.minutes)}</td>
                <td className="text-xs text-slate-500">{r.days.map((d) => `${d.date.toISOString().slice(8, 10)} (${d.minutes}m)`).join(", ")}</td></tr>
            ))}</tbody>
          </table></Paged></div>
        )}
      </Card>
    </div>
  );
}
