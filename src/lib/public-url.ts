/** URL absolut berbasis domain publik. Di balik reverse proxy (Nginx), req.url berisi host internal
 * (mis. localhost:3000), jadi host & protokol diambil dari header yang diteruskan proxy. */
export function publicUrl(path: string, req: Request): URL {
  const internal = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? internal.host;
  const fwdProto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const proto = fwdProto === "http" || fwdProto === "https" ? fwdProto : internal.protocol.replace(":", "");
  return new URL(path, `${proto}://${host}`);
}
