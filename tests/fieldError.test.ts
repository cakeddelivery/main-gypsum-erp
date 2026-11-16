import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FieldError, fieldsOf, withField, zField } from "@/lib/fieldError";
import { StockError } from "@/lib/stock";

describe("Error per kolom form", () => {
  it("FieldError, withField & ZodError → peta kolom", () => {
    expect(fieldsOf(new FieldError("joinDate", "Isi tanggal masuk"))).toEqual({ joinDate: "Isi tanggal masuk" });
    const e = withField(new StockError("Pilih jenis masalah"), "issueType");
    expect(e).toBeInstanceOf(StockError);
    expect(fieldsOf(e)).toEqual({ issueType: "Pilih jenis masalah" });
    const z1 = z.object({ name: z.string().min(2, "Nama wajib") }).safeParse({ name: "" });
    expect(fieldsOf(z1.error)).toEqual({ name: "Nama wajib" });
    expect(fieldsOf(new Error("x"))).toBeUndefined();
  });
  it("zField menunjuk kolom yang salah", () => {
    const fd = new FormData();
    fd.set("name", " A ");
    expect(() => zField(fd, "name", z.string().min(2, "Nama wajib"))).toThrow(FieldError);
    fd.set("name", " Budi ");
    expect(zField(fd, "name", z.string().min(2))).toBe("Budi");
  });
});
