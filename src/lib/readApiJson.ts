export async function readApiJson<T = { error?: string }>(
  res: Response,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 120);
    throw new Error(
      res.ok
        ? "서버 응답을 해석하지 못했습니다."
        : `서버 오류 (${res.status})${snippet ? `: ${snippet}` : ""}`,
    );
  }
}
