import { readFile } from "fs/promises";
import path from "path";
import { tokenize } from "../generate/match";
import type {
  EssayQuestion,
  ExperienceEpisode,
  FactItem,
  FactMaster,
  JobPosting,
  QuestionIntent,
} from "../types";

const EMPTY: FactMaster = { version: 1, facts: [] };
const GLOBAL_FACT_CAP = 5;
const SKILL_TYPES = new Set(["competency", "motivation"]);

function asStatus(raw: unknown): FactItem["status"] {
  if (raw === "locked" || raw === "reference" || raw === "disabled") return raw;
  return "reference";
}

function asCategory(raw: unknown): FactItem["category"] {
  if (
    raw === "metric" ||
    raw === "role" ||
    raw === "period" ||
    raw === "education" ||
    raw === "certification" ||
    raw === "skill" ||
    raw === "other"
  ) {
    return raw;
  }
  return "other";
}

function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
  return out.length ? out : undefined;
}

function parseFacts(raw: unknown): FactItem[] {
  if (!Array.isArray(raw)) return [];
  const facts: FactItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const value = typeof r.value === "string" ? r.value.trim() : "";
    if (!id || !label || !value) continue;
    facts.push({
      id,
      label,
      value,
      category: asCategory(r.category),
      episodeId: typeof r.episodeId === "string" ? r.episodeId : undefined,
      source: typeof r.source === "string" ? r.source : "fact-master",
      status: asStatus(r.status),
      tags: asStringArray(r.tags),
      preferredQuestionTypes: asStringArray(r.preferredQuestionTypes),
    });
  }
  return facts;
}

export async function loadFactMaster(): Promise<FactMaster> {
  try {
    const file = path.join(process.cwd(), "data", "fact-master.json");
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { version?: number; facts?: unknown };
    const facts = parseFacts(parsed.facts);
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      facts,
    };
  } catch (err) {
    console.warn("[fact-master] load failed — empty master:", err);
    return EMPTY;
  }
}

export function canonicalGroupId(
  episodeId: string,
  episodes: ExperienceEpisode[],
): string {
  const ep = episodes.find((e) => e.id === episodeId);
  return ep?.canonicalGroupId || episodeId;
}

function siblingEpisodeIds(
  episodeId: string,
  episodes: ExperienceEpisode[],
): Set<string> {
  const group = canonicalGroupId(episodeId, episodes);
  const ids = new Set<string>([episodeId]);
  for (const e of episodes) {
    if ((e.canonicalGroupId || e.id) === group) ids.add(e.id);
  }
  return ids;
}

/** locked Fact만. canonical group의 sibling episode도 같은 경험으로 본다. */
export function factsForEpisodes(
  master: FactMaster,
  episodeIds: string[],
  episodes: ExperienceEpisode[] = [],
): FactItem[] {
  const ids = new Set<string>();
  for (const id of episodeIds.filter(Boolean)) {
    for (const sib of siblingEpisodeIds(id, episodes)) ids.add(sib);
  }
  return master.facts.filter(
    (f) => f.status === "locked" && f.episodeId && ids.has(f.episodeId),
  );
}

/**
 * locked Fact가 하나라도 있으면 본문 소재 가능.
 * Fact 행이 전혀 없으면 Notion/레거시 fallback으로 허용.
 * reference/disabled만 있으면 불가.
 */
export function isEpisodeEvidenceEligible(
  episodeId: string,
  factMaster: FactMaster,
  episodes: ExperienceEpisode[] = [],
): boolean {
  const ids = siblingEpisodeIds(episodeId, episodes);
  const linked = factMaster.facts.filter(
    (f) => f.episodeId && ids.has(f.episodeId),
  );
  if (linked.some((f) => f.status === "locked")) return true;
  if (linked.length === 0) return true;
  return false;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}

/** episodeId 없는 locked Fact만, 문항·JD 관련성으로 최대 GLOBAL_FACT_CAP개. */
export function selectGlobalFactsForQuestion(params: {
  facts: FactItem[];
  question: EssayQuestion;
  intent: QuestionIntent;
  job: JobPosting;
}): FactItem[] {
  const { question, intent, job } = params;
  const haystack = [
    intent.questionType,
    question.title,
    question.prompt,
    ...intent.jdSignals,
    job.role,
    ...job.keywords,
    ...job.requirements,
    ...job.preferred,
    ...job.responsibilities,
  ].join(" ");
  const hayTokens = tokenize(haystack);
  const hayLower = haystack.toLowerCase();

  const scored: { f: FactItem; score: number }[] = [];
  for (const f of params.facts) {
    if (f.status !== "locked" || f.episodeId) continue;
    const typeHit = Boolean(
      f.preferredQuestionTypes?.includes(intent.questionType),
    );
    const tagHits = (f.tags ?? []).filter((tag) =>
      hayLower.includes(tag.toLowerCase()),
    ).length;
    const factTokens = tokenize(
      [f.label, f.value, ...(f.tags ?? [])].join(" "),
    );
    const tokenHit = overlapCount(factTokens, hayTokens);
    if (f.preferredQuestionTypes?.length && !typeHit) continue;
    if (
      (f.tags ?? []).some((t) => /약점|단점|장단점/.test(t)) &&
      intent.questionType !== "personality"
    ) {
      continue;
    }
    if (
      (f.category === "certification" || f.category === "skill") &&
      !SKILL_TYPES.has(intent.questionType)
    ) {
      continue;
    }
    if (intent.questionType === "aspiration" && !typeHit) continue;
    if (!typeHit && tagHits === 0 && tokenHit < 2) continue;
    const score = (typeHit ? 3 : 0) + tagHits * 2 + tokenHit;
    if (score <= 0) continue;
    scored.push({ f, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, GLOBAL_FACT_CAP).map((x) => x.f);
}
