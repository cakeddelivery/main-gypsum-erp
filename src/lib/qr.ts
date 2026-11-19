import QRCode from "qrcode";

/** QR code sebagai SVG (vektor, tajam saat dicetak) */
export async function qrSvg(text: string, size = 96): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
  return svg.replace("<svg ", `<svg width="${size}" height="${size}" role="img" aria-label="QR verifikasi dokumen" `);
}
