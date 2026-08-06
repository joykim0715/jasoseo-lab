import { claudeJson } from "../claude";
import type { JobPosting } from "../types";

const STRUCTURE_SYSTEM = `You are a Korean recruiting analyst.
Extract a structured job posting from raw text.
If a field is unknown, use empty string or empty array.
essayQuestionsHint: any application essay questions found in the posting.
warnings: note incomplete extraction, login walls, OCR uncertainty, etc. in Korean.
All string content in Korean when possible.`;

export async function structureJobPosting(
  rawText: string,
  priorWarnings: string[] = [],
): Promise<JobPosting> {
  const truncated = rawText.slice(0, 28000);
  const parsed = await claudeJson<{
    company?: string;
    role?: string;
    requirements?: string[];
    preferred?: string[];
    responsibilities?: string[];
    keywords?: string[];
    cultureSignals?: string[];
    essayQuestionsHint?: string[];
    warnings?: string[];
  }>({
    system: STRUCTURE_SYSTEM,
    user: `Raw job posting text:\n\n${truncated}`,
    maxTokens: 3000,
  });

  return {
    company: parsed.company?.trim() || "미상",
    role: parsed.role?.trim() || "미상",
    requirements: parsed.requirements ?? [],
    preferred: parsed.preferred ?? [],
    responsibilities: parsed.responsibilities ?? [],
    keywords: parsed.keywords ?? [],
    cultureSignals: parsed.cultureSignals ?? [],
    essayQuestionsHint: parsed.essayQuestionsHint ?? [],
    rawText: truncated,
    warnings: [...priorWarnings, ...(parsed.warnings ?? [])],
  };
}
