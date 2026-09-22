import type {
  CandidateProfile,
  EpisodeCandidate,
  EssayQuestion,
  ExperienceEpisode,
  JobPosting,
  QuestionIntent,
} from "../types";

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^0-9a-zA-Z가-힣+#.]/)
      .filter((t) => t.length >= 2),
  );
}

function episodeTokens(episode: ExperienceEpisode): Set<string> {
  return tokenize(
    [
      episode.title,
      episode.organization ?? "",
      episode.role ?? "",
      ...episode.highlights,
      ...episode.tags,
      ...episode.skills,
      episode.metrics ?? "",
      episode.situation ?? "",
      episode.task ?? "",
      episode.action ?? "",
      episode.result ?? "",
      ...episode.preferredQuestions,
    ].join(" "),
  );
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}

export function scoreEpisode(
  episode: ExperienceEpisode,
  job: JobPosting,
): number {
  const jobTokens = tokenize(
    [
      job.role,
      ...job.requirements,
      ...job.preferred,
      ...job.responsibilities,
      ...job.keywords,
    ].join(" "),
  );
  const epTokens = episodeTokens(episode);
  const overlap = overlapCount(epTokens, jobTokens);
  const densityBonus = Math.min(episode.highlights.join("").length / 200, 3);
  const metricBonus =
    episode.metrics || /\d/.test(episode.highlights.join(" ")) ? 2 : 0;
  return overlap + densityBonus + metricBonus;
}

/** 구버전 전역 JD 매칭. 강제 상위 4개 fallback은 유지하지 않음. */
export function selectEpisodes(
  profile: CandidateProfile,
  job: JobPosting,
  limit = 6,
): { episodes: ExperienceEpisode[]; notes: string[] } {
  const ranked = profile.experiences
    .map((e) => ({ e, score: scoreEpisode(e, job) }))
    .sort((a, b) => b.score - a.score);

  const chosen = ranked.slice(0, limit).filter((r) => r.score > 0).map((r) => r.e);

  const notes = chosen.map(
    (e) =>
      `· ${e.title} (매칭 점수 ${ranked.find((r) => r.e.id === e.id)?.score.toFixed(1)})`,
  );

  return { episodes: chosen, notes };
}

type Weights = {
  jd: number;
  question: number;
  intent: number;
  preferred: number;
  star: number;
  metric: number;
  highlight: number;
  tag: number;
};

const WEIGHTS: Record<string, Weights> = {
  competency: {
    jd: 1.2,
    question: 1,
    intent: 1,
    preferred: 1.2,
    star: 1,
    metric: 1.2,
    highlight: 1,
    tag: 1,
  },
  motivation: {
    jd: 1,
    question: 1.1,
    intent: 1.1,
    preferred: 1.2,
    star: 0.6,
    metric: 0.6,
    highlight: 0.8,
    tag: 1,
  },
  collaboration: {
    jd: 0.25,
    question: 1.6,
    intent: 1.4,
    preferred: 1.8,
    star: 0.8,
    metric: 0.4,
    highlight: 0.8,
    tag: 1.6,
  },
  personality: {
    jd: 0.25,
    question: 1.5,
    intent: 1.3,
    preferred: 1.8,
    star: 0.7,
    metric: 0.4,
    highlight: 0.8,
    tag: 1.3,
  },
  growth: {
    jd: 0.25,
    question: 1.5,
    intent: 1.3,
    preferred: 1.8,
    star: 0.7,
    metric: 0.4,
    highlight: 0.8,
    tag: 1.3,
  },
  aspiration: {
    jd: 0.15,
    question: 1,
    intent: 1,
    preferred: 1,
    star: 0.3,
    metric: 0.2,
    highlight: 0.4,
    tag: 0.5,
  },
  general: {
    jd: 0.8,
    question: 1,
    intent: 1,
    preferred: 1,
    star: 0.8,
    metric: 0.8,
    highlight: 0.8,
    tag: 0.8,
  },
};

const TYPE_ALIASES: Record<string, string[]> = {
  collaboration: ["협업", "팀워크", "조율", "소통", "갈등", "collaboration"],
  motivation: ["지원동기", "지원 동기", "motivation"],
  aspiration: ["포부", "입사 후", "aspiration"],
  personality: ["성격", "장단점", "장점", "단점", "약점", "personality"],
  growth: ["성장과정", "가치관", "growth"],
  competency: ["직무역량", "직무 역량", "competency"],
};

const GENERIC_PREF = new Set(["경험", "competency"]);

function preferredHits(
  episode: ExperienceEpisode,
  question: EssayQuestion,
  intent: QuestionIntent,
): string[] {
  const aliases = TYPE_ALIASES[intent.questionType] ?? [];
  const title = question.title.toLowerCase();
  const prompt = question.prompt.toLowerCase();
  const type = intent.questionType.toLowerCase();

  return episode.preferredQuestions.filter((p) => {
    const pt = p.toLowerCase();
    if (pt === type || aliases.some((a) => a.toLowerCase() === pt || pt.includes(a.toLowerCase()))) {
      return true;
    }
    if (GENERIC_PREF.has(pt) && intent.questionType !== "competency") return false;
    return title.includes(pt) || prompt.includes(pt);
  });
}

/** 문항 독립 relevance. 중복 감점은 buildEssayPlan에서만. */
export function rankEpisodesForQuestion(params: {
  profile: CandidateProfile;
  job: JobPosting;
  question: EssayQuestion;
  intent: QuestionIntent;
}): EpisodeCandidate[] {
  const { profile, job, question, intent } = params;
  const w = WEIGHTS[intent.questionType] ?? WEIGHTS.general;
  const jobTokens = tokenize(
    [
      job.role,
      ...job.requirements,
      ...job.preferred,
      ...job.responsibilities,
      ...job.keywords,
      ...intent.jdSignals,
    ].join(" "),
  );
  const questionTokens = tokenize(
    [question.title, question.prompt, intent.questionType].join(" "),
  );
  const intentTokens = tokenize(
    [...intent.goals, ...intent.evidencePriorities, ...intent.jdSignals].join(
      " ",
    ),
  );

  const scored: EpisodeCandidate[] = [];

  for (const episode of profile.experiences) {
    const epTokens = episodeTokens(episode);
    const jdOverlap = overlapCount(epTokens, jobTokens);
    const qOverlap = overlapCount(epTokens, questionTokens);
    const intentOverlap = overlapCount(epTokens, intentTokens);
    const prefHits = preferredHits(episode, question, intent);
    const preferredBonus = prefHits.length ? 3 + prefHits.length : 0;

    const weightedRelevance =
      jdOverlap * w.jd +
      qOverlap * w.question +
      intentOverlap * w.intent +
      preferredBonus * w.preferred;
    if (weightedRelevance <= 0) continue;

    const starFields = [
      episode.situation,
      episode.task,
      episode.action,
      episode.result,
    ].filter((v) => (v ?? "").trim().length > 0).length;
    const starBonus = starFields * 0.5 * w.star;
    const metricBonus =
      (episode.metrics || /\d/.test(episode.highlights.join(" ")) ? 2 : 0) *
      w.metric;
    const highlightBonus =
      Math.min(episode.highlights.join("").length / 200, 3) * w.highlight;
    const tagSkillBonus = Math.min(
      overlapCount(
        tokenize([...episode.tags, ...episode.skills].join(" ")),
        new Set([...jobTokens, ...questionTokens, ...intentTokens]),
      ) *
        0.3 *
        w.tag,
      2 * w.tag,
    );

    const reasons: string[] = [];
    if (jdOverlap) reasons.push(`JD 토큰 겹침 ${jdOverlap}`);
    if (qOverlap) reasons.push(`문항 토큰 겹침 ${qOverlap}`);
    if (intentOverlap) reasons.push(`의도 신호 겹침 ${intentOverlap}`);
    if (preferredBonus) {
      reasons.push(`preferredQuestions 일치 (${prefHits.join(", ")})`);
    }
    if (starFields) reasons.push(`STAR ${starFields}/4`);
    if (metricBonus) reasons.push("수치·지표 있음");
    if (highlightBonus) reasons.push("하이라이트 밀도");

    const score =
      weightedRelevance + starBonus + metricBonus + highlightBonus + tagSkillBonus;

    scored.push({
      episodeId: episode.id,
      score: Math.round(score * 10) / 10,
      reasons,
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}
