import {
  canonicalGroupId,
  factsForEpisodes,
  isEpisodeEvidenceEligible,
  selectGlobalFactsForQuestion,
} from "../profile/loadFactMaster";
import type {
  EpisodeCandidate,
  EssayPlan,
  EssayPlanItem,
  EssayQuestion,
  ExperienceEpisode,
  FactMaster,
  JobPosting,
  QuestionIntent,
} from "../types";

const DUPLICATE_PENALTY = 4;

function episodeById(
  episodes: ExperienceEpisode[],
  id?: string,
): ExperienceEpisode | undefined {
  if (!id) return undefined;
  return episodes.find((e) => e.id === id);
}

function isAspiration(intent: QuestionIntent, question: EssayQuestion): boolean {
  return (
    intent.questionType === "aspiration" ||
    /포부|입사\s*후/.test(`${question.title} ${question.prompt}`)
  );
}

function wantsSalesFraming(
  job: JobPosting,
  question: EssayQuestion,
  intent: QuestionIntent,
): boolean {
  const blob = [
    job.role,
    ...job.keywords,
    ...job.requirements,
    ...job.preferred,
    question.title,
    question.prompt,
    ...intent.jdSignals,
  ].join(" ");
  return /영업|제휴|설득|스폰서/.test(blob);
}

function intentWantsPastExperience(intent: QuestionIntent): boolean {
  const blob = [...intent.goals, ...intent.evidencePriorities].join(" ");
  return /과거|경험\s*근거|근거로.{0,12}기여|구체적\s*경험/.test(blob);
}

/**
 * 문항별 후보와 Fact Master로 EssayPlan을 만든다. LLM 없음.
 * 중복 감점은 canonicalGroup 기준, 이 레이어에서만.
 */
export function buildEssayPlan(params: {
  job: JobPosting;
  questions: EssayQuestion[];
  intents: QuestionIntent[];
  rankings: Record<string, EpisodeCandidate[]>;
  episodes: ExperienceEpisode[];
  factMaster: FactMaster;
  priorPrimaryEpisodeIds?: string[];
}): EssayPlan {
  const usedPrimaryCount = new Map<string, number>();
  for (const id of params.priorPrimaryEpisodeIds ?? []) {
    const g = canonicalGroupId(id, params.episodes);
    usedPrimaryCount.set(g, (usedPrimaryCount.get(g) ?? 0) + 1);
  }
  const items: EssayPlanItem[] = [];

  for (const question of params.questions) {
    const intent =
      params.intents.find((i) => i.questionId === question.id) ??
      ({
        questionId: question.id,
        questionType: "general",
        goals: [],
        evidencePriorities: [],
        jdSignals: params.job.keywords.slice(0, 6),
        avoid: [],
      } satisfies QuestionIntent);

    const ranked = params.rankings[question.id] ?? [];
    const adjusted = ranked
      .filter((c) =>
        isEpisodeEvidenceEligible(c.episodeId, params.factMaster, params.episodes),
      )
      .map((c) => {
        const group = canonicalGroupId(c.episodeId, params.episodes);
        return {
          c,
          group,
          adj: c.score - DUPLICATE_PENALTY * (usedPrimaryCount.get(group) ?? 0),
        };
      })
      .filter((x) => x.c.score > 0)
      .sort((a, b) => b.adj - a.adj);

    const optional = isAspiration(intent, question);
    let primary: (typeof adjusted)[number] | undefined = adjusted[0];
    if (optional) {
      const allowPast =
        intentWantsPastExperience(intent) && (adjusted[0]?.adj ?? 0) >= 12;
      primary = allowPast ? adjusted[0] : undefined;
    }

    const secondary =
      !optional && primary
        ? adjusted.find(
            (x) =>
              x.adj > 0 &&
              x.group !== primary.group &&
              x.c.episodeId !== primary.c.episodeId,
          )
        : undefined;

    if (primary) {
      usedPrimaryCount.set(
        primary.group,
        (usedPrimaryCount.get(primary.group) ?? 0) + 1,
      );
    }

    const episodeIds = [primary?.c.episodeId, secondary?.c.episodeId].filter(
      (id): id is string => Boolean(id),
    );
    const episodeFacts = factsForEpisodes(
      params.factMaster,
      episodeIds,
      params.episodes,
    );
    const selectedGroups = new Set(
      episodeIds.map((id) => canonicalGroupId(id, params.episodes)),
    );
    const globalFacts = selectGlobalFactsForQuestion({
      facts: params.factMaster.facts,
      question,
      intent,
      job: params.job,
    }).filter((f) => {
      if (f.episodeId) return selectedGroups.has(
        canonicalGroupId(f.episodeId, params.episodes),
      );
      return true;
    });
    const seen = new Set<string>();
    const allowedFacts = [...episodeFacts, ...globalFacts].filter((f) => {
      if (f.status !== "locked") return false;
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });

    const primaryEp = episodeById(params.episodes, primary?.c.episodeId);
    const secondaryEp = episodeById(params.episodes, secondary?.c.episodeId);
    const notes: string[] = [];
    if (primaryEp) notes.push(`주 소재: ${primaryEp.title}`);
    else notes.push("주 소재 없음 (적합 경험 미선택)");
    if (secondaryEp) notes.push(`보조 소재: ${secondaryEp.title}`);
    if (primary?.c.reasons.length) {
      notes.push(`이유: ${primary.c.reasons.slice(0, 4).join("; ")}`);
    }
    if ((usedPrimaryCount.get(primary?.group ?? "") ?? 0) > 1) {
      notes.push("핵심 경력 재사용 (중복 감점 후 여전히 최선)");
    }
    if (wantsSalesFraming(params.job, question, intent)) {
      notes.push(
        "작성 가이드: 현장 설득·제휴·의사결정 지원으로 연결 가능. 없는 영업 경력·CRM·쿼터 성과는 쓰지 않는다.",
      );
    }

    const goal = intent.goals[0] || question.title;
    const thesis = primaryEp
      ? `${question.title}: ${primaryEp.title}로 ${goal}`
      : `${question.title}: 경험 나열보다 방향·직무 연결 중심`;

    items.push({
      questionId: question.id,
      intent,
      primaryEpisodeId: primary?.c.episodeId,
      secondaryEpisodeId: secondary?.c.episodeId,
      allowedFactIds: allowedFacts.map((f) => f.id),
      targetJdSignals: intent.jdSignals.slice(0, 8),
      thesis,
      notes,
    });
  }

  return { items };
}
