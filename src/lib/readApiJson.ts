export async function readApiJson<T = { error?: string }>(
  res: Response,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 160);
    if (
      res.status === 504 ||
      /FUNCTION_INVOCATION_TIMEOUT|Gateway Timeout/i.test(snippet)
    ) {
      throw new Error(
        "서버 처리 시간이 초과되었습니다(504). 문항이 많거나 생성이 길어 타임아웃된 경우입니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    throw new Error(
      res.ok
        ? "서버 응답을 해석하지 못했습니다."
        : `서버 오류 (${res.status})${snippet ? `: ${snippet}` : ""}`,
    );
  }
}
