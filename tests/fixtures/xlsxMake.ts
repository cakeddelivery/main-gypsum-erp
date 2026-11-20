import JSZip from "jszip";

/** Pembuat .xlsx sintetis untuk tes (inlineStr, tanpa pustaka tambahan) */
export type SheetIn = { name: string; rows: (string | number | null)[][] };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = (n: number) => { let s = ""; for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

/** rowPerCell: meniru file TikTok asli — satu <row> per sel dengan nomor baris yang sama */
export async function makeXlsx(sheets: SheetIn[], opts: { rowPerCell?: boolean } = {}): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`);
  z.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  z.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  sheets.forEach((s, i) => {
    const cell = (v: string | number | null, ci: number, ri: number) => (v === null || v === "" ? "" : typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="str"><v>${esc(v)}</v></c>`);
    const rows = opts.rowPerCell ? s.rows.map((r, ri) => r.map((v, ci) => `<row r="${ri + 1}">${cell(v, ci, ri)}</row>`).join("")).join("") : s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === null || v === "" ? "" : typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join("")}</row>`).join("");
    z.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData>${rows}</sheetData></worksheet>`);
  });
  return Buffer.from(await z.generateAsync({ type: "uint8array" }));
}
