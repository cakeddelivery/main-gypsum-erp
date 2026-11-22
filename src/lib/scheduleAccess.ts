/** Owner & Supervisor boleh mengatur jadwal shift dirinya sendiri; pengelola jadwal lain tidak */
export const canSetOwnSchedule = (role: string) => role === "OWNER" || role === "SUPERVISOR";

/**
 * Apakah pengguna ditolak mengubah data karyawan ini karena itu data DIRINYA sendiri?
 * Absensi/validasi sendiri hanya boleh Owner (dasar potongan gaji). JADWAL sendiri boleh Owner & Supervisor tanpa menunggu atasan
 * (schedule: true); peran lain tetap dikunci.
 */
export function ownRecordBlocked(user: { role: string; employeeId: string | null }, targetEmployeeId: string, opts: { schedule?: boolean } = {}) {
  if (!user.employeeId || targetEmployeeId !== user.employeeId) return false;
  if (user.role === "OWNER") return false;
  return !(opts.schedule && canSetOwnSchedule(user.role));
}
