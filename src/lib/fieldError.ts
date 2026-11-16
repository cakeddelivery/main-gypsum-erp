/**
 * Error validasi yang menunjuk kolom form tertentu (atribut `name` di form).
 * Dilempar dari server action / lib → ActionForm menandai kolom itu merah, menampilkan pesan di bawahnya,
 * lalu menggulir & fokus ke sana (isian lain tetap utuh).
 */
export class FieldError extends Error {
  fields: Record<string, string>;
  constructor(field: string | Record<string, string>, message?: string) {
    const fields = typeof field === "string" ? { [field]: message ?? "Isian belum benar" } : field;
    super(message ?? Object.values(fields)[0] ?? "Isian belum benar");
    this.fields = fields;
  }
}

/** Ambil peta kolom → pesan dari error apa pun (FieldError, ZodError, atau error ber-properti `field`) */
export function fieldsOf(e: unknown): Record<string, string> | undefined {
  if (!e || typeof e !== "object") return undefined;
  const x = e as { fields?: unknown; field?: unknown; message?: unknown; issues?: unknown };
  if (x.fields && typeof x.fields === "object") return x.fields as Record<string, string>;
  if (typeof x.field === "string" && x.field) return { [x.field]: String(x.message ?? "Isian belum benar") };
  if (Array.isArray(x.issues)) {
    const out: Record<string, string> = {};
    for (const i of x.issues as { path?: (string | number)[]; message?: string }[]) {
      const k = (i.path ?? []).join(".");
      if (k && !out[k]) out[k] = i.message ?? "Isian belum benar";
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/** Tempelkan nama kolom form ke error domain apa pun (tipe error tetap, mis. StockError) */
export function withField<E extends Error>(e: E, field: string): E {
  (e as E & { field: string }).field = field;
  return e;
}

/** Validasi satu kolom FormData dengan skema zod; gagal → FieldError untuk kolom itu */
export function zField<T>(fd: FormData, name: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }): T {
  const v = fd.get(name);
  const r = schema.safeParse(typeof v === "string" ? v.trim() : "");
  if (!r.success) throw new FieldError(name, r.error.issues[0]?.message ?? "Isian belum benar");
  return r.data;
}
