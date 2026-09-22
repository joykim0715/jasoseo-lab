import { readFileSync } from "fs";
import path from "path";
import { findNonKoreanIssues, collectAllowedTerms } from "./koreanOnly";
import { rankEpisodesForQuestion } from "./match";
import { normalizeFreeFormQuestions } from "./freeForm";
import { fallbackIntent, inferQuestionType } from "./questionIntent";
import { buildEssayPlan } from "./plan";
import { previousResultSchema } from "./schemas";
import { retrieveEssaysForQuestion } from "./retrieveEssays";
import { clampProvenance, validateEssay } from "./validateEssay";
import { runLlmResilienceSelfCheck } from "../llmResilience";
import { snapshotToEpisodes } from "../profile/loadProfile";
import {
  canonicalGroupId,
  factsForEpisodes,
  isEpisodeEvidenceEligible,
  selectGlobalFactsForQuestion,
} from "../profile/loadFactMaster";
import type {
  CandidateProfile,
  EssayArchiveItem,
  EssayQuestion,
  ExperienceEpisode,
  FactMaster,
  JobPosting,
} from "../types";

function ep(
  partial: Partial<ExperienceEpisode> & { id: string; title: string },
): ExperienceEpisode {
  return {
    highlights: [],
    tags: [],
    skills: [],
    preferredQuestions: [],
    source: "portfolio",
    ...partial,
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function healthcareJob(): JobPosting {
  return {
    company: "헬스케어데이터",
    role: "데이터 분석가",
    requirements: ["SQL", "헬스케어 데이터 분석", "SPSS"],
    preferred: ["대시보드", "웨어러블"],
    responsibilities: ["로그 데이터 전처리", "리텐션 분석"],
    keywords: ["헬스케어", "데이터", "SQL", "SPSS", "대시보드"],
    cultureSignals: [],
    essayQuestionsHint: [],
    rawText: "",
    warnings: [],
  };
}

function q(id: string, title: string, prompt: string): EssayQuestion {
  return { id, title, prompt, charLimit: 800, countSpaces: true };
}

function independentExperienceCount(
  primaryId: string | undefined,
  secondaryId: string | undefined,
  allowedFactIds: string[],
  master: FactMaster,
  episodes: ExperienceEpisode[],
): number {
  const groups = new Set<string>();
  if (primaryId) groups.add(canonicalGroupId(primaryId, episodes));
  if (secondaryId) groups.add(canonicalGroupId(secondaryId, episodes));
  for (const id of allowedFactIds) {
    const f = master.facts.find((row) => row.id === id);
    if (f?.episodeId) groups.add(canonicalGroupId(f.episodeId, episodes));
  }
  return groups.size;
}

function globalFactIdsOf(
  item: { primaryEpisodeId?: string; secondaryEpisodeId?: string; allowedFactIds: string[] },
  master: FactMaster,
  episodes: ExperienceEpisode[],
): string[] {
  const episodeFact = new Set(
    factsForEpisodes(
      master,
      [item.primaryEpisodeId, item.secondaryEpisodeId].filter(
        (id): id is string => Boolean(id),
      ),
      episodes,
    ).map((f) => f.id),
  );
  return item.allowedFactIds.filter((id) => !episodeFact.has(id));
}

function loadMaster(): FactMaster {
  const file = path.join(process.cwd(), "data", "fact-master.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as FactMaster;
  return { version: parsed.version ?? 1, facts: parsed.facts ?? [] };
}

function realProfile(): { profile: CandidateProfile; master: FactMaster } {
  const snap = JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "profile.snapshot.json"), "utf8"),
  );
  const episodes = snapshotToEpisodes(snap);
  return {
    master: loadMaster(),
    profile: {
      ...snap,
      experiences: episodes,
      essayArchive: [],
    },
  };
}

export async function runEngine20SelfCheck() {
  const qA = normalizeFreeFormQuestions();
  const qB = normalizeFreeFormQuestions(qA);
  assert(qA.length === 5, "freeform length");
  assert(
    qA.every((item, i) => item.id === qB[i].id),
    "freeform ids stable",
  );
  const kept = normalizeFreeFormQuestions([
    { id: "keep-a", title: "x", prompt: "", charLimit: 1, countSpaces: true },
  ]);
  assert(kept[0].id === "keep-a", "preserve existing id");
  assert(kept[1].id === "freeform-2", "fill remaining stable ids");

  assert(inferQuestionType("협업 경험", "팀과 일한 경험") === "collaboration", "collab title");
  assert(inferQuestionType("입사 후 포부", "1년차 적응·기여 → 3~5년 전문성 성장") === "aspiration", "aspiration over 성장");
  assert(inferQuestionType("성장과정", "가치관이 형성된 계기") === "growth", "growth");
  assert(inferQuestionType("성격의 장단점", "장점과 단점") === "personality", "personality");
  assert(inferQuestionType("직무 관련 경험", "STAR로 서술") === "competency", "competency");

  const sqlBody = "SQL과 SPSS, Figma, MySQL로 분석했습니다.";
  const issues = findNonKoreanIssues(sqlBody, ["SQL", "SPSS", "Figma", "MySQL"]);
  assert(issues.length === 0, `trusted terms flagged: ${issues.join(",")}`);
  assert(
    findNonKoreanIssues("SQL을 사용했습니다.", []).includes("SQL"),
    "SQL without trusted should flag",
  );

  const foreign = findNonKoreanIssues("商品과 thus를 섞음", ["SQL"]);
  assert(foreign.length > 0, "foreign script should flag");
  assert(
    findNonKoreanIssues("I am a hard worker and I love data analysis.", ["SQL"]).length > 0,
    "english sentence should flag",
  );

  const job = healthcareJob();
  const relevant = ep({
    id: "data-ep",
    title: "국책과제 데이터",
    highlights: ["SQL 6.9만 건"],
    tags: ["데이터"],
    skills: ["SQL", "SPSS"],
    preferredQuestions: ["직무역량", "competency"],
    metrics: "리텐션 83%",
    canonicalGroupId: "data-ep",
  });
  const collabEp = ep({
    id: "collab-ep",
    title: "총학생회 협업",
    highlights: ["갈등을 조율하고 설문으로 합의"],
    tags: ["협업", "조율"],
    preferredQuestions: ["협업", "collaboration", "성격"],
    canonicalGroupId: "collab-ep",
  });
  const irrelevant = ep({
    id: "unrelated",
    title: "무관한 아르바이트",
    highlights: ["매장 정리"],
    tags: ["매장"],
  });
  const profile: CandidateProfile = {
    name: "테스트",
    tagline: "",
    bio: "",
    about: "",
    portfolioUrl: "",
    education: [],
    skills: [],
    experiences: [relevant, collabEp, irrelevant],
    works: [],
    certifications: [],
    values: [],
    essayArchive: [],
  };
  const question: EssayQuestion = {
    id: "q1",
    title: "직무역량 및 경험",
    prompt: "직무 경험",
    charLimit: 800,
    countSpaces: true,
  };
  const intent = fallbackIntent(question, job);
  const ranked = rankEpisodesForQuestion({
    profile,
    job,
    question,
    intent,
  });
  assert(
    ranked.some((c) => c.episodeId === "data-ep"),
    "relevant episode ranked",
  );
  assert(
    ranked.every((c) => c.episodeId !== "unrelated"),
    "irrelevant episode must not be forced",
  );

  const collabQ = q("qb", "협업 경험", "팀과 협업하여 갈등을 조율한 경험을 쓰세요.");
  const collabIntent = fallbackIntent(collabQ, job);
  assert(collabIntent.questionType === "collaboration", "collab intent");
  const collabRanked = rankEpisodesForQuestion({
    profile,
    job,
    question: collabQ,
    intent: collabIntent,
  });
  const collabPlan = buildEssayPlan({
    job,
    questions: [collabQ],
    intents: [collabIntent],
    rankings: { [collabQ.id]: collabRanked },
    episodes: profile.experiences,
    factMaster: {
      version: 1,
      facts: [
        {
          id: "f-data",
          label: "데이터",
          value: "83%",
          category: "metric",
          episodeId: "data-ep",
          source: "t",
          status: "locked",
        },
        {
          id: "f-collab",
          label: "협업",
          value: "조율",
          category: "other",
          episodeId: "collab-ep",
          source: "t",
          status: "locked",
        },
      ],
    },
  });
  const picked = [
    collabPlan.items[0].primaryEpisodeId,
    collabPlan.items[0].secondaryEpisodeId,
  ];
  assert(
    picked.includes("collab-ep"),
    `collab episode should be selected, got ${picked.join(",")}`,
  );
  assert(
    !(picked[0] === "data-ep" && picked[1] === "data-ep"),
    "collab must not be data-only",
  );

  const { profile: real, master } = realProfile();
  assert(
    real.experiences.some((e) => e.id === "floorball"),
    "floorball episode exists",
  );
  assert(
    isEpisodeEvidenceEligible("floorball", master, real.experiences),
    "floorball eligible via bound fact",
  );
  assert(
    master.facts.every((f) => f.id !== "fact-sales-framing"),
    "sales framing must not be a Fact",
  );
  const floorballFact = master.facts.find((f) => f.id === "fact-metric-floorball");
  assert(floorballFact?.episodeId === "floorball", "floorball fact bound to episode");
  assert(
    !isEpisodeEvidenceEligible("taekwondo-assistant", master, real.experiences),
    "taekwondo reference-only ineligible",
  );
  assert(
    isEpisodeEvidenceEligible("homecare-researcher", master, real.experiences),
    "homecare eligible",
  );
  assert(
    isEpisodeEvidenceEligible("work-01", master, real.experiences),
    "work-01 eligible via canonical group",
  );

  const aspQ = q("qc", "입사 후 포부", "1년차 기여와 비전");
  const aspIntent = fallbackIntent(aspQ, job);
  assert(aspIntent.questionType === "aspiration", "aspiration type");
  const aspPlan = buildEssayPlan({
    job,
    questions: [aspQ],
    intents: [aspIntent],
    rankings: {
      [aspQ.id]: rankEpisodesForQuestion({
        profile: real,
        job,
        question: aspQ,
        intent: aspIntent,
      }),
    },
    episodes: real.experiences,
    factMaster: master,
  });
  assert(
    !aspPlan.items[0].primaryEpisodeId,
    `aspiration should not auto-pick primary, got ${aspPlan.items[0].primaryEpisodeId}`,
  );
  assert(!aspPlan.items[0].secondaryEpisodeId, "aspiration no secondary");
  assert(
    !aspPlan.items[0].allowedFactIds.includes("fact-toeic"),
    "disabled TOEIC not allowed",
  );
  assert(
    !aspPlan.items[0].allowedFactIds.includes("fact-looker-studio"),
    "reference Looker not allowed",
  );
  assert(
    !aspPlan.items[0].allowedFactIds.includes("fact-taekwondo"),
    "reference taekwondo not allowed",
  );
  assert(
    !aspPlan.items[0].allowedFactIds.includes("fact-metric-floorball"),
    "aspiration must not pull floorball narrative fact",
  );
  assert(
    !aspPlan.items[0].allowedFactIds.includes("fact-weakness"),
    "aspiration must not pull weakness",
  );
  assert(
    independentExperienceCount(
      aspPlan.items[0].primaryEpisodeId,
      aspPlan.items[0].secondaryEpisodeId,
      aspPlan.items[0].allowedFactIds,
      master,
      real.experiences,
    ) === 0,
    "aspiration independent experiences should be 0",
  );

  const compQ = q("qa", "직무역량 및 경험", "직무와 관련된 경험을 STAR로");
  const compIntent = fallbackIntent(compQ, job);
  const compRanked = rankEpisodesForQuestion({
    profile: real,
    job,
    question: compQ,
    intent: compIntent,
  });
  const compPlan = buildEssayPlan({
    job,
    questions: [compQ],
    intents: [compIntent],
    rankings: { [compQ.id]: compRanked },
    episodes: real.experiences,
    factMaster: master,
  });
  const primary = compPlan.items[0].primaryEpisodeId;
  const secondary = compPlan.items[0].secondaryEpisodeId;
  const pGroup = real.experiences.find((e) => e.id === primary)?.canonicalGroupId;
  const sGroup = real.experiences.find((e) => e.id === secondary)?.canonicalGroupId;
  assert(primary, "competency has primary");
  assert(
    pGroup === "homecare-researcher" ||
      primary === "homecare-researcher" ||
      primary === "work-01",
    `competency primary should be homecare group, got ${primary}`,
  );
  if (secondary) {
    assert(
      pGroup !== sGroup,
      `canonical group duplicated primary/secondary: ${primary}/${secondary}`,
    );
  }
  assert(
    independentExperienceCount(
      primary,
      secondary,
      compPlan.items[0].allowedFactIds,
      master,
      real.experiences,
    ) <= 2,
    "competency independent experiences > 2",
  );
  if (primary !== "floorball" && secondary !== "floorball") {
    assert(
      !compPlan.items[0].allowedFactIds.includes("fact-metric-floorball"),
      "floorball should not ride along on competency",
    );
  }
  assert(
    !compPlan.items[0].allowedFactIds.includes("fact-weakness"),
    "weakness should not ride along on competency",
  );
  assert(
    factsForEpisodes(master, [primary ?? ""], real.experiences).every(
      (f) => f.status === "locked",
    ),
    "episode facts locked only",
  );

  const persQ = q("qp", "성격의 장단점", "장점과 단점");
  const persIntent = fallbackIntent(persQ, job);
  const persGlobals = selectGlobalFactsForQuestion({
    facts: master.facts,
    question: persQ,
    intent: persIntent,
    job,
  }).map((f) => f.id);
  assert(persGlobals.includes("fact-weakness"), "personality can take weakness");
  assert(
    !persGlobals.includes("fact-metric-floorball"),
    "personality must not take floorball as global fact",
  );

  const growthQ = q("qg", "성장과정", "가치관이 형성된 계기");
  const growthIntent = fallbackIntent(growthQ, job);
  const growthGlobals = selectGlobalFactsForQuestion({
    facts: master.facts,
    question: growthQ,
    intent: growthIntent,
    job,
  }).map((f) => f.id);
  assert(
    !growthGlobals.includes("fact-metric-floorball"),
    "floorball is an episode, not a global fact",
  );
  assert(
    !growthGlobals.includes("fact-weakness"),
    "growth must not take weakness",
  );

  const growthPlan = buildEssayPlan({
    job,
    questions: [growthQ],
    intents: [growthIntent],
    rankings: {
      [growthQ.id]: rankEpisodesForQuestion({
        profile: real,
        job,
        question: growthQ,
        intent: growthIntent,
      }),
    },
    episodes: real.experiences,
    factMaster: master,
  });
  const growthPicked = [
    growthPlan.items[0].primaryEpisodeId,
    growthPlan.items[0].secondaryEpisodeId,
  ];
  if (!growthPicked.includes("floorball")) {
    assert(
      !growthPlan.items[0].allowedFactIds.includes("fact-metric-floorball"),
      "unselected floorball must not leak as fact",
    );
  }

  const realCollabQ = q("qB", "협업 경험", "팀과 협업하여 갈등을 조율한 경험을 쓰세요.");
  const realCollabIntent = fallbackIntent(realCollabQ, job);
  const realCollabPlan = buildEssayPlan({
    job,
    questions: [realCollabQ],
    intents: [realCollabIntent],
    rankings: {
      [realCollabQ.id]: rankEpisodesForQuestion({
        profile: real,
        job,
        question: realCollabQ,
        intent: realCollabIntent,
      }),
    },
    episodes: real.experiences,
    factMaster: master,
  });
  const realCollabPrimary = realCollabPlan.items[0].primaryEpisodeId;
  assert(
    realCollabPrimary !== "homecare-researcher" &&
      realCollabPrimary !== "work-01",
    `collab must not force homecare primary, got ${realCollabPrimary}`,
  );
  const collabPicked = [
    realCollabPlan.items[0].primaryEpisodeId,
    realCollabPlan.items[0].secondaryEpisodeId,
  ];
  if (!collabPicked.includes("floorball")) {
    assert(
      !realCollabPlan.items[0].allowedFactIds.includes("fact-metric-floorball"),
      "unselected floorball must not leak into collab facts",
    );
  }
  assert(
    !realCollabPlan.items[0].allowedFactIds.includes("fact-weakness"),
    "collab must not take weakness",
  );

  const terms = collectAllowedTerms({
    job,
    episodes: real.experiences.filter((e) => e.id === "homecare-researcher"),
    facts: master.facts.filter((f) =>
      ["fact-toeic", "fact-looker-studio", "fact-skills"].includes(f.id),
    ),
  });
  assert(
    !terms.some((t) => /toeic/i.test(t)),
    "disabled TOEIC must not be trusted term",
  );
  assert(
    !terms.some((t) => /looker/i.test(t)),
    "reference Looker must not be trusted term",
  );
  assert(
    terms.some((t) => /sql/i.test(t)),
    "locked skills SQL should be trusted",
  );

  const fNirsOk = findNonKoreanIssues("fNIRS 센서로 기획했습니다.", ["fNIRS"]);
  assert(fNirsOk.length === 0, `fNIRS trusted flagged: ${fNirsOk.join(",")}`);

  const legacy = previousResultSchema.parse({
    personas: [],
    answers: [
      {
        questionId: "freeform-1",
        title: "성장과정",
        prompt: "p",
        body: "본문",
        charCount: 2,
        charLimit: 800,
        countSpaces: true,
        withinLimit: true,
        constraintNotes: [],
        usedEpisodeIds: [],
      },
    ],
    matchingNotes: [],
    personaFeedback: "",
  });
  assert(legacy.plan === undefined, "legacy plan optional");

  let planRejected = false;
  try {
    previousResultSchema.parse({
      ...legacy,
      plan: { items: [{ questionId: "broken" }] },
    });
  } catch {
    planRejected = true;
  }
  assert(planRejected, "broken plan must fail zod");

  const filler =
    "담백한 문장으로 구조를 보여 주는 문체 참고용 예시 본문입니다. ";
  function arch(
    partial: Partial<EssayArchiveItem> & { id: string },
  ): EssayArchiveItem {
    return {
      name: partial.name ?? "archive",
      question: partial.question ?? "성장과정",
      answer: (partial.answer ?? filler).repeat(3),
      ...partial,
    };
  }
  const archive = [
    arch({
      id: "z-ref",
      referenceType: "reference",
      rating: "Medium",
      role: "마케팅",
    }),
    arch({
      id: "a-draft",
      referenceType: "draft",
      rating: "High",
      role: "데이터 분석가",
    }),
    arch({
      id: "m-low",
      referenceType: "reference",
      rating: "Low",
      question: "성장과정",
      role: "데이터 분석가",
    }),
    arch({
      id: "b-base",
      referenceType: "baseline",
      rating: "Medium",
      question: "성장과정",
      role: "데이터 분석가",
    }),
    arch({
      id: "c-final",
      referenceType: "final",
      rating: "High",
      question: "직무역량 및 경험",
      role: "데이터 분석가",
    }),
  ];
  const growthRet = retrieveEssaysForQuestion({
    archive,
    job,
    question: growthQ,
    intent: growthIntent,
  });
  assert(growthRet[0]?.id === "b-base", `baseline first, got ${growthRet.map((r) => r.id)}`);
  assert(
    !growthRet.some((r) => r.id === "a-draft"),
    "draft must be excluded",
  );
  const lowIdx = growthRet.findIndex((r) => r.id === "m-low");
  const baseIdx = growthRet.findIndex((r) => r.id === "b-base");
  if (lowIdx >= 0) {
    assert(lowIdx > baseIdx, "low must rank after baseline");
  }
  const refIdx = growthRet.findIndex((r) => r.id === "z-ref");
  if (refIdx >= 0) {
    assert(refIdx > baseIdx, "plain reference after baseline");
  }
  const compRet = retrieveEssaysForQuestion({
    archive,
    job,
    question: compQ,
    intent: compIntent,
  });
  assert(
    compRet.some((r) => r.id === "c-final"),
    "similar questionType/role final should retrieve",
  );

  const prov = clampProvenance({
    usedEpisodeIds: ["homecare-researcher", "floorball"],
    usedFactIds: ["fact-skills", "fact-toeic"],
    allowedEpisodeIds: ["homecare-researcher"],
    allowedFactIds: ["fact-skills"],
  });
  assert(
    prov.usedEpisodeIds.join(",") === "homecare-researcher",
    "strip unallowed episode",
  );
  assert(prov.usedFactIds.join(",") === "fact-skills", "strip unallowed fact");
  assert(prov.issues.length === 2, "provenance warnings");

  const lockedFact = {
    id: "f-ret",
    label: "리텐션",
    value: "83% (참여자 기준)",
    category: "metric" as const,
    source: "t",
    status: "locked" as const,
  };
  const selected = real.experiences.filter((e) => e.id === "homecare-researcher");
  const okBody =
    "헬스케어데이터 데이터 분석가로서 SQL과 SPSS로 리텐션 83%를 만들었습니다.\n\n이어서 현장 가이드를 정리하고, 같은 지표로 다음 액션을 설명했습니다.";
  const okVal = validateEssay({
    body: okBody,
    question: q("v1", "직무역량 및 경험", "직무"),
    job,
    selectedEpisodes: selected,
    allEpisodes: real.experiences,
    facts: [lockedFact],
    allowedTerms: ["SQL", "SPSS"],
  });
  assert(okVal.valid, `allowed numbers/SQL should pass: ${okVal.issues.map((i) => i.message)}`);
  assert(
    !okVal.issues.some((i) => i.code === "unverified_number"),
    "83 should be allowed",
  );
  assert(
    !okVal.issues.some((i) => i.code === "korean_only"),
    "trusted SQL/SPSS should pass",
  );

  const badNum = validateEssay({
    body: `${okBody} 성과 777건을 추가했습니다.`,
    question: q("v2", "직무역량 및 경험", "직무"),
    job,
    selectedEpisodes: selected,
    allEpisodes: real.experiences,
    facts: [lockedFact],
    allowedTerms: ["SQL", "SPSS"],
  });
  assert(
    badNum.issues.some((i) => i.code === "unverified_number"),
    "777 should be unverified",
  );

  const over = validateEssay({
    body: "가".repeat(40),
    question: { id: "v3", title: "직무역량", prompt: "p", charLimit: 10, countSpaces: true },
    job,
    selectedEpisodes: selected,
    facts: [lockedFact],
  });
  assert(over.issues.some((i) => i.code === "over_limit"), "charLimit error");

  const empty = validateEssay({
    body: "",
    question: q("v4", "직무역량", "p"),
    job,
    selectedEpisodes: selected,
    facts: [lockedFact],
  });
  assert(
    empty.issues.some((i) => i.code === "empty_body" && i.severity === "error"),
    "empty error",
  );

  const foreignVal = validateEssay({
    body: `${okBody} 商品을 넣음.`,
    question: q("v5", "직무역량 및 경험", "직무"),
    job,
    selectedEpisodes: selected,
    facts: [lockedFact],
    allowedTerms: ["SQL", "SPSS"],
  });
  assert(
    foreignVal.issues.some((i) => i.code === "korean_only"),
    "foreign script should issue",
  );

  const legacy2 = previousResultSchema.parse({
    answers: [
      {
        questionId: "freeform-1",
        title: "성장과정",
        prompt: "p",
        body: "본문",
        charCount: 2,
        charLimit: 800,
        countSpaces: true,
        withinLimit: true,
        constraintNotes: [],
        usedEpisodeIds: [],
      },
    ],
    matchingNotes: [],
  });
  assert(legacy2.answers[0].validation === undefined, "legacy answer has no validation field");
  assert(legacy2.answers[0].usedFactIds === undefined, "legacy usedFactIds optional");

  const llmRes = await runLlmResilienceSelfCheck();
  assert(llmRes === "ok", "llm resilience");

  return "ok";
}

export function dumpPlanCases(): string {
  const { profile, master } = realProfile();
  const job = healthcareJob();
  const cases: { name: string; questions: EssayQuestion[] }[] = [
    {
      name: "A 직무역량",
      questions: [q("qA", "직무역량 및 경험", "직무와 관련된 경험을 STAR로 서술하세요.")],
    },
    {
      name: "B 협업",
      questions: [q("qB", "협업 경험", "팀과 협업하여 갈등을 조율한 경험을 쓰세요.")],
    },
    {
      name: "C 입사 후 포부",
      questions: [q("qC", "입사 후 포부", "입사 후 1년차 기여와 비전을 쓰세요.")],
    },
    { name: "D 자유양식 5문항", questions: normalizeFreeFormQuestions() },
  ];

  const lines: string[] = [];
  for (const spec of cases) {
    const intents = spec.questions.map((question) => fallbackIntent(question, job));
    const rankings: Record<string, ReturnType<typeof rankEpisodesForQuestion>> = {};
    for (const question of spec.questions) {
      const intent = intents.find((i) => i.questionId === question.id)!;
      rankings[question.id] = rankEpisodesForQuestion({
        profile,
        job,
        question,
        intent,
      });
    }
    const plan = buildEssayPlan({
      job,
      questions: spec.questions,
      intents,
      rankings,
      episodes: profile.experiences,
      factMaster: master,
    });
    lines.push(`## ${spec.name}`);
    for (const question of spec.questions) {
      const item = plan.items.find((i) => i.questionId === question.id)!;
      const ranked = rankings[question.id].slice(0, 5);
      lines.push(`- ${question.title} (${item.intent.questionType})`);
      lines.push(
        `  top: ${ranked.map((c) => `${c.episodeId}:${c.score}`).join(", ") || "(none)"}`,
      );
      const p = profile.experiences.find((e) => e.id === item.primaryEpisodeId);
      const s = profile.experiences.find((e) => e.id === item.secondaryEpisodeId);
      const globals = globalFactIdsOf(item, master, profile.experiences);
      const independent = independentExperienceCount(
        item.primaryEpisodeId,
        item.secondaryEpisodeId,
        item.allowedFactIds,
        master,
        profile.experiences,
      );
      lines.push(
        `  primary: ${item.primaryEpisodeId ?? "none"} group=${p?.canonicalGroupId ?? "-"}`,
      );
      lines.push(
        `  secondary: ${item.secondaryEpisodeId ?? "none"} group=${s?.canonicalGroupId ?? "-"}`,
      );
      lines.push(`  facts: ${item.allowedFactIds.join(", ") || "(none)"}`);
      lines.push(`  globalFacts: ${globals.join(", ") || "(none)"}`);
      lines.push(`  independentExperiences: ${independent}`);
    }
  }
  return lines.join("\n");
}

const invoked = process.argv[1]?.replace(/\\/g, "/").endsWith("/selfcheck.ts");
if (invoked) {
  runEngine20SelfCheck()
    .then((r) => {
      console.log(r);
      console.log(dumpPlanCases());
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
