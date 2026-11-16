/** Owner & Supervisor boleh mengatur jadwal shift dirinya sendiri; pengelola jadwal lain tidak */
export const canSetOwnSchedule = (role: string) => role === "OWNER" || role === "SUPERVISOR";
