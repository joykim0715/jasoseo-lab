import { llmJson, SchemaType, type ResponseSchema } from "../llm";
import type { JobPosting } from "../types";

const STRUCTURE_SYSTEM = `You are a Korean recruiting analyst.
Extract a structured job posting from raw text.
If a field is unknown, use empty string or empty array.
Array fields MUST be JSON arrays of strings, never a single string.
role: prefer explicit job title from "페이지 제목", "OG 제목", or "공고 제목(H1)" over body mentions like "프로덕트 매니저" that appear only as role descriptions.
company: prefer company name from the title line when present (e.g. Wanted titles often look like "[회사명] 포지션명").
essayQuestionsHint: any application essay questions found in the posting.
warnings: only for real extraction problems (login walls, empty body, OCR uncertainty). Do NOT warn just because you inferred a reasonable role from a clear page/H1 title. Do NOT invent speculative warnings.
Output ONE JSON object only. No markdown, no commentary before or after.
All string content in Korean when possible.`;

const STRING_ARRAY = {
  type: SchemaType.ARRAY,
  items: { type: SchemaType.STRING },
};

const JOB_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    company: { type: SchemaType.STRING },
    role: { type: SchemaType.STRING },
    requirements: STRING_ARRAY,
    preferred: STRING_ARRAY,
    responsibilities: STRING_ARRAY,
    keywords: STRING_ARRAY,
    cultureSignals: STRING_ARRAY,
    essayQuestionsHint: STRING_ARRAY,
    warnings: STRING_ARRAY,
  },
  required: [
    "company",
    "role",
    "requirements",
    "preferred",
    "responsibilities",
    "keywords",
    "cultureSignals",
    "essayQuestionsHint",
    "warnings",
  ],
} as ResponseSchema;

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
    maxTokens: 4000,
    responseSchema: JOB_SCHEMA,
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
