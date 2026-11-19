import { int, optStr, str } from "@/lib/action";

/** Isian addendum dari form (dipisah agar file "use server" hanya mengekspor action) */
export function addendumArgs(fd: FormData) {
  return {
    text: str(fd, "text"),
    start: str(fd, "start"),
    baseSalary: str(fd, "baseSalary") ? int(fd, "baseSalary") : undefined,
    endDate: optStr(fd, "endDate") ?? undefined,
  };
}
