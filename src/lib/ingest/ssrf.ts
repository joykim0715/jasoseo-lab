/** Block private / link-local / metadata targets to reduce SSRF risk. */
export function assertSafePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("유효하지 않은 URL입니다.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("http(s) URL만 지원합니다.");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("로컬/내부 호스트는 가져올 수 없습니다.");
  }

  // Literal IPv4 private ranges
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      throw new Error("사설 IP 주소는 가져올 수 없습니다.");
    }
  }

  return url;
}
