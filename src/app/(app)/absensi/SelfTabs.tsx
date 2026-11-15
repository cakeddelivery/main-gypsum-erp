import Link from "next/link";
import type { AttendanceStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Role } from "@prisma/client";
import { addDays, dateStr, fmtDate, fmtDay, MONTHS, monthRange, todayStr } from "@/lib/time";
import { ATT_LABEL } from "@/lib/attendance";
import { fmtMinutes } from "@/lib/lateRecap";
import { BACKDATE_DAYS, canDecideLeave, LEAVE_KIND_LABEL, MAX_LEAVE_DAYS } from "@/lib/leave";
import { Badge, Empty, Field } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { Avatar } from "@/components/Avatar";
import { avatarUrl } from "@/lib/profilePhoto";
import { cancelLeaveRequest, decideLeaveRequest, submitLeaveRequest } from "./actions";
import { LeaveFields } from "./LeaveFields";

const DOT: Record<AttendanceStatus, string> = { HADIR: "bg-emerald-500", TERLAMBAT: "bg-amber-500", IZIN: "bg-sky-500", SAKIT: "bg-violet-500", LIBUR: "bg-slate-300", ALPA: "bg-rose-500" };
const TONE = { HADIR: "green", TERLAMBAT: "amber", IZIN: "blue", SAKIT: "purple", ALPA: "red", LIBUR: "gray" } as const;
const LEAVE_TONE = { MENUNGGU: "amber", DISETUJUI: "green", DITOLAK: "red" } as const;
const LEAVE_STATUS = { MENUNGGU: "Menunggu", DISETUJUI: "Disetujui", DITOLAK: "Ditolak" } as const;
const hm = (d: Date | null) => (d ? d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\./g, ":") : null);
const range = (a: Date, b: Date) => (dateStr(a) === dateStr(b) ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);

/** Riwayat bulan ini: ringkasan, total telat, kalender bertitik warna, daftar harian */
export async function Riwayat({ employeeId, month }: { employeeId: string; month: string }) {
  const [y, m] = month.split("-").map(Number);
  const { start, end } = monthRange(y, m);
  const today = todayStr();
  const rows = await prisma.attendance.findMany({ where: { employeeId, date: { gte: start, lt: end } }, orderBy: { date: "desc" } });
  const byDay = new Map(rows.map((r) => [dateStr(r.date), r]));
  const count = (s: AttendanceStatus) => rows.filter((r) => r.status === s).length;
  const lateMin = rows.reduce((a, r) => a + (r.status === "TERLAMBAT" ? r.lateMinutes : 0), 0);
  const first = `${month}-01`;
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Senin = 0
  const prev = addDays(first, -1).slice(0, 7);
  const next = addDays(first, 32).slice(0, 7);
  const stats: [string, number | string, string][] = [
    ["Hadir", count("HADIR") + count("TERLAMBAT"), "text-emerald-700"],
    ["Telat", `${count("TERLAMBAT")}×`, "text-amber-700"],
    ["Izin", count("IZIN"), "text-sky-700"],
    ["Sakit", count("SAKIT"), "text-violet-700"],
    ["Libur", count("LIBUR"), "text-slate-700"],
    ["Alpa", count("ALPA"), "text-rose-700"],
  ];
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-900">Riwayat absensi</h2>
          <p className="text-sm text-slate-500">{MONTHS[m - 1]} {y}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/absensi?tab=riwayat&month=${prev}`} className="btn-secondary btn-icon" aria-label="Bulan sebelumnya">‹</Link>
          {next <= today.slice(0, 7) && <Link href={`/absensi?tab=riwayat&month=${next}`} className="btn-secondary btn-icon" aria-label="Bulan berikutnya">›</Link>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 keep-cols">
        {stats.map(([k, v, c]) => (
          <div key={k} className="card px-2 py-3 text-center"><div className={`text-2xl font-extrabold ${c}`}>{v}</div><div className="text-xs text-slate-500">{k}</div></div>
        ))}
      </div>
      <p className="text-sm text-slate-600">Total telat bulan ini: <b>{lateMin ? fmtMinutes(lateMin) : "0 menit"}</b> (tercatat di slip gaji)</p>
      <div className="card p-3">
        <div className="grid grid-cols-7 gap-y-1 text-center keep-cols">
          {["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"].map((d) => <div key={d} className="pb-1 text-xs font-semibold text-slate-500">{d}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} />)}
          {Array.from({ length: days }, (_, i) => {
            const day = `${month}-${String(i + 1).padStart(2, "0")}`;
            const a = byDay.get(day);
            const isToday = day === today;
            return (
              <div key={day} className={`mx-auto flex h-11 w-10 flex-col items-center justify-center rounded-lg ${isToday ? "bg-brand-50 font-bold text-brand-700" : day > today ? "text-slate-400" : "text-slate-800"}`}>
                <span className="text-sm">{i + 1}</span>
                <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${a ? DOT[a.status] : "bg-transparent"}`} title={a ? ATT_LABEL[a.status] : undefined} />
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
          {(["HADIR", "TERLAMBAT", "IZIN", "SAKIT", "LIBUR", "ALPA"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${DOT[s]}`} />{s === "TERLAMBAT" ? "Telat" : s === "ALPA" ? "Alpa" : ATT_LABEL[s]}</span>
          ))}
        </div>
      </div>
      {rows.length ? (
        <div className="card overflow-hidden">
          <Paged>
            <ul className="divide-y divide-slate-100">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{fmtDay(r.date)}</div>
                    <div className="truncate text-sm text-slate-500">{r.checkIn ? `${hm(r.checkIn)} – ${hm(r.checkOut) ?? "…"}` : r.note || "—"}</div>
                  </div>
                  <Badge tone={TONE[r.status]}>{r.status === "TERLAMBAT" ? `Telat ${r.lateMinutes} mnt` : r.status === "ALPA" ? "Alpa" : ATT_LABEL[r.status]}</Badge>
                </li>
              ))}
            </ul>
          </Paged>
        </div>
      ) : (
        <Empty title="Belum ada absensi bulan ini" />
      )}
    </div>
  );
}

/** Izin & Sakit: ajukan (popup) + daftar pengajuan sendiri; Supervisor/Owner juga melihat daftar persetujuan */
export async function IzinSakit({ user }: { user: { role: Role; employeeId: string | null } }) {
  const today = todayStr();
  const approver = canDecideLeave(user.role);
  const [mine, pending, decided] = await Promise.all([
    user.employeeId ? prisma.leaveRequest.findMany({ where: { employeeId: user.employeeId }, orderBy: { createdAt: "desc" }, take: 60 }) : Promise.resolve([]),
    approver ? prisma.leaveRequest.findMany({ where: { status: "MENUNGGU" }, orderBy: { createdAt: "asc" }, include: { employee: { include: { division: true, user: true } } } }) : Promise.resolve([]),
    approver ? prisma.leaveRequest.findMany({ where: { status: { not: "MENUNGGU" } }, orderBy: { decidedAt: "desc" }, take: 50, include: { employee: { include: { division: true } } } }) : Promise.resolve([]),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-900">Izin &amp; Sakit</h2>
          <p className="text-sm text-slate-500">Ajukan dari HP; disetujui Supervisor atau Owner</p>
        </div>
        {user.employeeId && (
          <Modal trigger="+ Ajukan izin / sakit" title="Ajukan izin / sakit">
            <ModalForm action={submitLeaveRequest} className="space-y-3">
              <LeaveFields today={today} min={addDays(today, -BACKDATE_DAYS)} maxDays={MAX_LEAVE_DAYS} />
              <Submit>Ajukan</Submit>
            </ModalForm>
          </Modal>
        )}
      </div>

      {approver && (
        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">Menunggu persetujuan {pending.length > 0 && <Badge tone="amber">{pending.length}</Badge>}</h3>
          {pending.length ? (
            <div className="card divide-y divide-slate-100">
              {pending.map((r) => (
                <div key={r.id} className="space-y-3 p-4">
                  <div className="flex gap-3">
                  <Avatar name={r.employee.name} src={r.employee.user ? avatarUrl(r.employee.user) : null} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900">{r.employee.name}</div>
                    <div className="text-xs text-slate-500">{r.employee.division.name} · diajukan {fmtDate(r.createdAt)}</div>
                    <div className="text-sm text-slate-700">{LEAVE_KIND_LABEL[r.kind]} · {range(r.dateFrom, r.dateTo)}</div>
                    <div className="text-sm text-slate-500">{r.reason}{r.attachmentPath && <> · <a href={`/api/files/leave/${r.id}`} target="_blank" className="link">📎 Lihat lampiran</a></>}</div>
                  </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Modal trigger="Tolak" triggerClass="btn-secondary text-rose-700" title={`Tolak ${LEAVE_KIND_LABEL[r.kind].toLowerCase()} ${r.employee.name}`}>
                      <ModalForm action={decideLeaveRequest} className="space-y-3">
                        <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="tolak" />
                        <Field label="Alasan penolakan"><textarea name="rejectReason" className="input" rows={3} required placeholder="Mis. tidak ada surat dokter" /></Field>
                        <Submit className="btn-danger">Tolak pengajuan</Submit>
                      </ModalForm>
                    </Modal>
                    <ActionForm action={decideLeaveRequest} confirm={`Setujui ${LEAVE_KIND_LABEL[r.kind].toLowerCase()} ${r.employee.name} (${range(r.dateFrom, r.dateTo)})? Absensi hari itu dicatat ${LEAVE_KIND_LABEL[r.kind]}.`}>
                      <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="setuju" />
                      <Submit className="btn-success" pendingText="…">✓ Setujui</Submit>
                    </ActionForm>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">Tidak ada pengajuan yang menunggu.</p>
          )}
        </section>
      )}

      {user.employeeId && (
        <section className="space-y-2">
          {approver && <h3 className="font-bold text-slate-800">Pengajuan saya</h3>}
          {mine.length ? (
            <div className="card overflow-hidden">
              <Paged>
                <ul className="divide-y divide-slate-100">
                  {mine.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900">{LEAVE_KIND_LABEL[r.kind]} · {range(r.dateFrom, r.dateTo)}</div>
                        <div className="text-sm text-slate-500">{r.reason}{r.attachmentPath && " · 📎 lampiran"}</div>
                        {r.status === "DITOLAK" && r.rejectReason && <div className="text-sm text-rose-700">Ditolak {r.decidedBy}: {r.rejectReason}</div>}
                        {r.status === "DISETUJUI" && <div className="text-xs text-slate-500">Disetujui {r.decidedBy} · {fmtDate(r.decidedAt)}</div>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={LEAVE_TONE[r.status]}>{LEAVE_STATUS[r.status]}</Badge>
                        {r.status === "MENUNGGU" && (
                          <ActionForm action={cancelLeaveRequest} confirm="Batalkan pengajuan ini?">
                            <input type="hidden" name="id" value={r.id} />
                            <Submit className="text-xs text-slate-500 underline" pendingText="…">Batalkan</Submit>
                          </ActionForm>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Paged>
            </div>
          ) : (
            <Empty title="Belum ada pengajuan" hint="Ketuk “+ Ajukan izin / sakit” bila berhalangan masuk kerja." />
          )}
        </section>
      )}

      {approver && decided.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">Sudah diputuskan</h3>
          <div className="table-wrap">
            <Paged>
              <table className="tbl">
                <thead><tr><th>Karyawan</th><th>Jenis</th><th>Tanggal</th><th>Alasan</th><th>Status</th><th>Oleh</th></tr></thead>
                <tbody>
                  {decided.map((r) => (
                    <tr key={r.id}>
                      <td>{r.employee.name}<div className="text-xs text-slate-500">{r.employee.division.name}</div></td>
                      <td>{LEAVE_KIND_LABEL[r.kind]}</td>
                      <td>{range(r.dateFrom, r.dateTo)}</td>
                      <td className="max-w-[16rem] whitespace-normal">{r.reason}{r.attachmentPath && <> · <a href={`/api/files/leave/${r.id}`} target="_blank" className="link">📎</a></>}{r.rejectReason && <div className="text-xs text-rose-700">Ditolak: {r.rejectReason}</div>}</td>
                      <td><Badge tone={LEAVE_TONE[r.status]}>{LEAVE_STATUS[r.status]}</Badge></td>
                      <td className="text-xs">{r.decidedBy}<div className="text-slate-500">{fmtDate(r.decidedAt)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          </div>
        </section>
      )}
      <p className="text-xs text-slate-500">Sakit lebih dari 1 hari wajib melampirkan foto surat dokter. Hari yang disetujui tercatat Izin/Sakit di absensi (mengikuti aturan gaji yang berlaku) dan menggantikan status Alpa otomatis. Pengajuan untuk hari yang sudah lewat paling lama {BACKDATE_DAYS} hari ke belakang.</p>
    </div>
  );
}

