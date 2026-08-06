import { structureJobPosting } from "./structureJd";
import type { JobPosting } from "../types";

export async function ingestFromText(text: string): Promise<JobPosting> {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length < 20) {
    throw new Error("공고 텍스트가 너무 짧습니다. 본문을 더 붙여넣어 주세요.");
  }
  return structureJobPosting(cleaned);
}
