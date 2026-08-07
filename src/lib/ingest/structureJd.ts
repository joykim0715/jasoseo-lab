import { llmJson } from "../llm";
import type { JobPosting } from "../types";

const STRUCTURE_SYSTEM = `You are a Korean recruiting analyst.
Extract a structured job posting from raw text.
If a field is unknown, use empty string or empty array.
Array fields MUST be JSON arrays of strings, never a single string.
essayQuestionsHint: any application essay questions found in the posting.
warnings: note incomplete extraction, login walls, OCR uncertainty, etc. in Korean.
All string content in Korean when possible.`;

/** LLM이 string[] 대신 string을 줘도 글자 단위로 펼쳐지지 않게 정규화 */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    // 줄바꿈/불릿으로 여러 항목이 온 경우만 분리
    const parts = trimmed
      .split(/\n+|•|·|(?:^|\s)[-*]\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length > 1 ? parts : [trimmed];
  }
  return [];
}

export async function structureJobPosting(
  rawText: string,
  priorWarnings: string[] = [],
): Promise<JobPosting> {
  const truncated = rawText.slice(0, 28000);
  const parsed = await llmJson<{
    company?: string;
    role?: string;
    requirements?: unknown;
    preferred?: unknown;
    responsibilities?: unknown;
    keywords?: unknown;
    cultureSignals?: unknown;
    essayQuestionsHint?: unknown;
    warnings?: unknown;
  }>({
    system: STRUCTURE_SYSTEM,
    user: `Raw job posting text:\n\n${truncated}`,
    maxTokens: 3000,
  });

  return {
    company: parsed.company?.trim() || "미상",
    role: parsed.role?.trim() || "미상",
    requirements: asStringArray(parsed.requirements),
    preferred: asStringArray(parsed.preferred),
    responsibilities: asStringArray(parsed.responsibilities),
    keywords: asStringArray(parsed.keywords),
    cultureSignals: asStringArray(parsed.cultureSignals),
    essayQuestionsHint: asStringArray(parsed.essayQuestionsHint),
    rawText: truncated,
    warnings: [...priorWarnings, ...asStringArray(parsed.warnings)],
  };
}
