import { countChars, isWithinLimit } from "./charCount";
import { findNonKoreanIssues } from "./koreanOnly";
import type {
  EssayQuestion,
  EssayValidationIssue,
  EssayValidationResult,
  ExperienceEpisode,
  FactItem,
  JobPosting,
} from "../types";

const NUM_RE = /\d+(?:\.\d+)?/g;

export function clampProvenance(params: {
  usedEpisodeIds: string[];
  usedFactIds: string[];
  allowedEpisodeIds: string[];
  allowedFactIds: string[];
}): {
  usedEpisodeIds: string[];
  usedFactIds: string[];
  issues: EssayValidationIssue[];
} {
  const epAllow = new Set(params.allowedEpisodeIds);
  const factAllow = new Set(params.allowedFactIds);
  const issues: EssayValidationIssue[] = [];
  const usedEpisodeIds = [
    ...new Set(params.usedEpisodeIds.filter(Boolean)),
  ].filter((id) => {
    if (epAllow.has(id)) return true;
    issues.push({
      code: "unallowed_episode",
      severity: "warning",
      message: `허용되지 않은 경험 ID 제거: ${id}`,
    });
    return false;
  });
  const usedFactIds = [...new Set(params.usedFactIds.filter(Boolean))].filter(
    (id) => {
      if (factAllow.has(id)) return true;
      issues.push({
        code: "unallowed_fact",
        severity: "warning",
        message: `허용되지 않은 Fact ID 제거: ${id}`,
      });
      return false;
    },
  );
  return { usedEpisodeIds, usedFactIds, issues };
}

function evidenceBlob(
  episodes: ExperienceEpisode[],
  facts: FactItem[],
  job: JobPosting,
): string {
  return [
    job.company,
    job.role,
    ...episodes.flatMap((e) => [
      e.title,
      e.organization ?? "",
      e.role ?? "",
      e.period ?? "",
      e.metrics ?? "",
      ...e.highlights,
    ]),
    ...facts.map((f) => `${f.label} ${f.value}`),
  ].join(" ");
}

function allowedNumbers(blob: string): Set<string> {
  const set = new Set<string>();
  for (const m of blob.match(NUM_RE) ?? []) set.add(m);
  return set;
}

function isGenericPlanNumber(text: string, index: number, raw: string): boolean {
  const ctx = text.slice(Math.max(0, index - 10), index + raw.length + 10);
  if (/년차|가지|문단|회[\s.]|개\s*문단|개\s*문항/.test(ctx)) return true;
  if (/\d+\s*[~～-]\s*\d+\s*년/.test(ctx)) return true;
  if (/(?:1|3|5)\s*년/.test(ctx) && /포부|비전|기여|성장|적응/.test(ctx)) {
    return true;
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n <= 5 && /문단|역할|가지|개/.test(ctx)) return true;
  return false;
}

function thirdExperienceIssues(
  body: string,
  selected: ExperienceEpisode[],
  all: ExperienceEpisode[],
): EssayValidationIssue[] {
  const selectedIds = new Set(selected.map((e) => e.id));
  const issues: EssayValidationIssue[] = [];
  for (const ep of all) {
    if (selectedIds.has(ep.id)) continue;
    const markers = [ep.organization, ep.title].filter(
      (s): s is string => Boolean(s && s.trim().length >= 6),
    );
    for (const m of markers) {
      if (body.includes(m)) {
        issues.push({
          code: "third_experience",
          severity: "warning",
          message: `선택되지 않은 경험 언급: ${m}`,
        });
        break;
      }
    }
  }
  return issues;
}

function jdAsFactIssues(
  body: string,
  job: JobPosting,
  evidence: string,
): EssayValidationIssue[] {
  const issues: EssayValidationIssue[] = [];
  const claims = [...job.requirements, ...job.preferred].filter(
    (s) => s.trim().length >= 4,
  );
  for (const req of claims) {
    if (!body.includes(req)) continue;
    if (evidence.includes(req)) continue;
    if (!/보유|가능|자격|경험\s*있/.test(body)) continue;
    issues.push({
      code: "jd_as_fact",
      severity: "warning",
      message: `JD 요구를 지원자 사실처럼 보임: ${req.slice(0, 24)}`,
    });
  }
  return issues;
}

function repetitionIssue(body: string): EssayValidationIssue | undefined {
  const compact = body.replace(/\s/g, "");
  if (compact.length < 48) return undefined;
  const n = 12;
  const counts = new Map<string, number>();
  for (let i = 0; i <= compact.length - n; i++) {
    const g = compact.slice(i, i + n);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  if ([...counts.values()].some((v) => v >= 5)) {
    return {
      code: "repetition",
      severity: "warning",
      message: "동일 구절이 과도하게 반복됨",
    };
  }
  return undefined;
}

export function validateEssay(params: {
  body: string;
  question: EssayQuestion;
  job: JobPosting;
  selectedEpisodes: ExperienceEpisode[];
  allEpisodes?: ExperienceEpisode[];
  facts: FactItem[];
  allowedTerms?: string[];
  provenanceIssues?: EssayValidationIssue[];
}): EssayValidationResult {
  const issues: EssayValidationIssue[] = [...(params.provenanceIssues ?? [])];
  const body = params.body.trim();
  const { question, job } = params;

  if (!body) {
    issues.push({
      code: "empty_body",
      severity: "error",
      message: "본문이 비어 있습니다",
    });
  } else if (body.length < 80) {
    issues.push({
      code: "too_short",
      severity: "error",
      message: "본문이 너무 짧습니다",
    });
  }

  if (
    question.charLimit > 0 &&
    !isWithinLimit(body, question.charLimit, question.countSpaces)
  ) {
    issues.push({
      code: "over_limit",
      severity: "error",
      message: `글자 수 초과: ${countChars(body, question.countSpaces)} / ${question.charLimit}`,
    });
  }

  if (body.length > 200 && !/\n\n/.test(params.body)) {
    issues.push({
      code: "no_paragraphs",
      severity: "warning",
      message: "문단 구분이 없습니다",
    });
  }

  const evidence = evidenceBlob(params.selectedEpisodes, params.facts, job);
  const allowed = allowedNumbers(evidence);
  if (body) {
    NUM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = NUM_RE.exec(body))) {
      const raw = m[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (isGenericPlanNumber(body, m.index, raw)) continue;
      if (allowed.has(raw)) continue;
      issues.push({
        code: "unverified_number",
        severity: "error",
        message: `허용 evidence에 없는 숫자 ${raw}`,
      });
    }
  }

  issues.push(
    ...thirdExperienceIssues(
      body,
      params.selectedEpisodes,
      params.allEpisodes ?? params.selectedEpisodes,
    ),
  );
  issues.push(...jdAsFactIssues(body, job, evidence));

  const rep = repetitionIssue(body);
  if (rep) issues.push(rep);

  const korean = findNonKoreanIssues(body, params.allowedTerms);
  for (const tok of korean.slice(0, 8)) {
    issues.push({
      code: "korean_only",
      severity: "error",
      message: `허용되지 않은 외국어/문자: ${tok}`,
    });
  }

  if (job.company !== "미상" && body && !body.includes(job.company)) {
    issues.push({
      code: "company_unmentioned",
      severity: "warning",
      message: "회사명 언급 조건 미충족",
    });
  }

  const valid = !issues.some((i) => i.severity === "error");
  return { valid, issues };
}
