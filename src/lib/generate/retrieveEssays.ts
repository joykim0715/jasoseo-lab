import { tokenize } from "./match";
import { inferQuestionType } from "./questionIntent";
import type {
  EssayArchiveItem,
  EssayPlanItem,
  EssayQuestion,
  EssayReferenceType,
  JobPosting,
  QuestionIntent,
} from "../types";

export const MAX_STYLE_REFS = 3;

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}

export function parseReferenceType(
  raw?: string,
): EssayReferenceType | undefined {
  const t = (raw ?? "").trim().toLowerCase();
  if (["baseline", "기준", "기준본"].includes(t)) return "baseline";
  if (["final", "제출", "최종"].includes(t)) return "final";
  if (["draft", "초안"].includes(t)) return "draft";
  if (["reference", "참고"].includes(t)) return "reference";
  return undefined;
}

function ratingRank(raw?: string): "high" | "medium" | "low" | undefined {
  const t = (raw ?? "").toLowerCase();
  if (/high|높/.test(t)) return "high";
  if (/low|낮/.test(t)) return "low";
  if (/medium|중/.test(t)) return "medium";
  return undefined;
}

function archiveQuestionType(item: EssayArchiveItem): string {
  return inferQuestionType(item.question, item.name || "");
}

export function scoreEssayReference(params: {
  item: EssayArchiveItem;
  job: JobPosting;
  question: EssayQuestion;
  intent: QuestionIntent;
}): number {
  const { item, job, question, intent } = params;
  const refType = item.referenceType ?? parseReferenceType(item.rating);
  if (item.referenceType === "draft" || refType === "draft") return -1000;

  let score = 1;
  if (item.referenceType === "baseline") score += 80;
  else if (item.referenceType === "final") score += 25;
  else if (item.referenceType === "reference") score += 5;

  const rating = ratingRank(item.rating);
  if (rating === "high") score += 20;
  else if (rating === "medium") score += 5;
  else if (rating === "low") score -= 20;

  const itemType = archiveQuestionType(item);
  if (itemType === intent.questionType) score += 25;
  else if (itemType !== "general") score -= 4;

  const jobTokens = tokenize(
    [job.role, ...job.keywords, ...intent.jdSignals].join(" "),
  );
  const qTokens = tokenize(`${question.title} ${question.prompt}`);
  const itemQTokens = tokenize(item.question);
  const roleTokens = tokenize(item.role ?? "");
  const jobRole = tokenize(job.role);

  score += overlapCount(itemQTokens, qTokens) * 4;
  score += overlapCount(roleTokens, jobRole) * 6;
  score += overlapCount(roleTokens, jobTokens) * 2;
  score += overlapCount(tokenize(item.company ?? ""), tokenize(job.company));
  if (item.tone) score += 1;

  return score;
}

export function retrieveEssaysForQuestion(params: {
  archive: EssayArchiveItem[];
  job: JobPosting;
  question: EssayQuestion;
  intent: QuestionIntent;
  planItem?: EssayPlanItem;
}): EssayArchiveItem[] {
  const scored = params.archive
    .filter((item) => (item.answer ?? "").trim().length > 40)
    .map((item) => ({
      item,
      score: scoreEssayReference({
        item,
        job: params.job,
        question: params.question,
        intent: params.intent,
      }),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.id.localeCompare(b.item.id);
    });

  return scored.slice(0, MAX_STYLE_REFS).map((row) => row.item);
}

function redactReferenceText(text: string, item: EssayArchiveItem): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  for (const token of [item.company, item.role, item.name]) {
    const name = token?.trim();
    if (name && name.length >= 2) cleaned = cleaned.split(name).join("[대상]");
  }
  return cleaned.replace(
    /\d+(?:[.,]\d+)?(?:\s*(?:%p|%|만|명|건|개|원))?/g,
    "[수치]",
  );
}

export function formatDraftReferenceCues(
  items: EssayArchiveItem[],
): {
  id: string;
  question: string;
  opening: string;
  rhythmExcerpt: string;
}[] {
  return items.slice(0, 2).map((item) => {
    const cleaned = redactReferenceText(item.answer, item);
    const sentences = cleaned
      .split(/(?<=[.?!。])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const clip = (value: string) => value.slice(0, 150);
    return {
      id: item.id,
      question: item.question,
      opening: clip(sentences[0] ?? cleaned),
      rhythmExcerpt: clip(sentences[1] ?? sentences[0] ?? cleaned),
    };
  });
}

export function formatStyleReferencesForDraft(
  items: EssayArchiveItem[],
): { id: string; question: string; tone?: string; referenceType?: string; answerExcerpt: string }[] {
  return items.map((a) => ({
    id: a.id,
    question: a.question,
    tone: a.tone,
    referenceType: a.referenceType,
    answerExcerpt: a.answer.slice(0, 700),
  }));
}
