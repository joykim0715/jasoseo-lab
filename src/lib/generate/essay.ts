import {
  getLastLlmCall,
  llmJson,
  SchemaType,
  type ResponseSchema,
} from "../llm";
import { clipToCharLimit, countChars, isWithinLimit } from "./charCount";
import { collectAllowedTerms, KOREAN_ONLY_RULE } from "./koreanOnly";
import { rankEpisodesForQuestion } from "./match";
import { buildEssayPlan } from "./plan";
import { analyzeQuestionIntents, fallbackIntent } from "./questionIntent";
import {
  formatStyleReferencesForDraft,
  retrieveEssaysForQuestion,
} from "./retrieveEssays";
import { clampProvenance, validateEssay } from "./validateEssay";
import { loadFactMaster } from "../profile/loadFactMaster";
import { setTimingQuestion, timingLog } from "../llmResilience";
import type {
  CandidateProfile,
  EssayAnswer,
  EssayArchiveItem,
  EssayPlan,
  EssayPlanItem,
  EssayQuestion,
  EssayValidationIssue,
  ExperienceEpisode,
  FactItem,
  GenerateResult,
  HiringPersona,
  JobPosting,
  SetupConfig,
  WritingConstraints,
} from "../types";

/** 톤·품질 규칙은 항상 적용 (UI에서 고정) */
const BASE_CONSTRAINTS = [
  KOREAN_ONLY_RULE,
  "구체적 수치(지표)를 최소 1개 이상 포함 — 제공된 Fact의 숫자만 사용",
  "지원 회사명·포지션을 자연스럽게 언급",
  "존댓말·격식체 사용",
  "제공된 경험·Fact 외 사실 날조 금지",
];

function constraintLines(c: WritingConstraints): string[] {
  const lines: string[] = [...BASE_CONSTRAINTS];
  if (c.freeText.trim()) lines.push(c.freeText.trim());

  if (c.structureStar) {
    lines.push(
      "구성: STAR(상황→과제→본인 행동→정량/정성 결과) 흐름으로 전개. 역할·기여가 드러나게 쓸 것",
    );
  }
  if (c.leadWithPoint) {
    lines.push(
      "구성: 두괄식. 답변·문단 첫 문장에 핵심 주장/성과를 두고 근거를 이어갈 것",
    );
  }
  if (c.causalLogic) {
    lines.push(
      "논리: 문제(또는 목표)→선택 이유→실행→결과로 인과가 끊기지 않게 연결. 근거 없는 결론 금지",
    );
  }
  if (c.jdLink) {
    lines.push(
      "논리: JD 요구·우대 역량과 서술 경험을 명시적으로 연결해 '왜 이 포지션에 맞는지'가 보이게 할 것",
    );
  }
  if (c.smoothFlow) {
    lines.push(
      "흐름: 문장·문단 전환을 자연스럽게. 갑작스런 주제 점프·군더더기·미사여구 나열 금지",
    );
  }
  if (c.noRepetition) {
    lines.push(
      "흐름: 동일 경험·표현·키워드를 반복하지 말고, 문장마다 새로운 정보·해석을 추가할 것",
    );
  }

  if (c.blindSchool) {
    lines.push(
      "블라인드: 구체 학교명 대신 '○○대학교'·'관련 전공 과정' 등으로 일반화. 학력 브랜드로 어필하지 말 것",
    );
  }
  if (c.blindCompany) {
    lines.push(
      "블라인드: 이전 근무·인턴 기업명은 '이전 근무처'·'관련 기업' 등으로 일반화. 지원 회사명은 예외로 자연스럽게 언급 가능",
    );
  }
  if (c.blindProject) {
    lines.push(
      "블라인드: 사내·특정 프로젝트명은 역할·성과 중심으로 서술하고 고유 프로젝트명은 일반화",
    );
  }
  if (c.blindGpa) {
    lines.push("블라인드: 학점·석차·수석 등 학력 상세 수치·서열 표현 비노출");
  }
  if (c.blindPersonal) {
    lines.push(
      "블라인드: 출신지역·거주지·가족관계·집안 배경 등 개인 신상 비노출",
    );
  }
  if (c.blindDemographics) {
    lines.push(
      "블라인드: 나이·생년·성별을 암시하는 표현(몇 살, 남/여, ○○년생 등) 금지",
    );
  }
  return lines;
}

function formatEpisode(e: ExperienceEpisode): string {
  const parts = [
    `id=${e.id}`,
    `제목=${e.title}`,
    e.organization ? `조직=${e.organization}` : "",
    e.role ? `역할=${e.role}` : "",
    e.period ? `기간=${e.period}` : "",
    e.situation ? `상황=${e.situation}` : "",
    e.task ? `과제=${e.task}` : "",
    e.action ? `행동=${e.action}` : "",
    e.result ? `결과=${e.result}` : "",
    e.metrics ? `지표=${e.metrics}` : "",
    e.highlights.length ? `하이라이트=${e.highlights.join("; ")}` : "",
    e.skills.length ? `스킬=${e.skills.join(", ")}` : "",
    e.tags.length ? `태그=${e.tags.join(", ")}` : "",
  ];
  return `- ${parts.filter(Boolean).join(" | ")}`;
}

const DRAFT_OUTPUT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    body: { type: SchemaType.STRING },
    usedEpisodeIds: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    usedFactIds: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
  },
  required: ["body", "usedEpisodeIds", "usedFactIds"],
} as ResponseSchema;

const DRAFT_SYSTEM = `당신은 국내 대기업·스타트업 합격 자소서를 다수 작성한 한국어 자기소개서 전문 라이터입니다.

${KOREAN_ONLY_RULE}

역할 분리:
- Fact source = selected ExperienceEpisode + allowed locked Facts 만.
- Style source = styleReferences (문체·문단 구조·정보 밀도·두괄식·전환만).
- Job source = JobPosting (회사 요구. 지원자 보유 사실이 아님).
- Writing strategy = QuestionIntent + EssayPlan.

작성 원칙:
1) 없는 사실·수치·직함 날조 금지. reference/disabled Fact 사용 금지.
2) AI 티 나는 상투어 금지.
3) 추상 주장 대신 구체 행동·의사결정·수치·학습.
4) 문단은 2~4개. body는 \\n\\n 로 문단 구분.
5) 존댓말 완결 문장. 바로 제출 가능한 완성본만.
6) 한글만. 허용된 도구·자격 고유명사는 유지.
7) EssayPlan thesis·지정 경험만 깊게. 제3 경험 금지.
8) JD의 요구·우대(운전·자격·제품 경험 등)를 지원자 보유 사실로 쓰지 않는다.
9) styleReferences 안의 회사명·직무명·경험·수치·자격·사실은 현재 답변의 사실 source가 아니다. 문체만 참고한다.`;

type DraftPayload = {
  body: string;
  usedEpisodeIds: string[];
  usedFactIds: string[];
};

function lockedFacts(facts: FactItem[]): FactItem[] {
  return facts.filter((f) => {
    if (f.status === "locked") return true;
    if (process.env.NODE_ENV !== "production") {
      console.warn("[draftOne] skipped non-locked fact", f.id, f.status);
    }
    return false;
  });
}

async function draftOne(params: {
  profile: CandidateProfile;
  job: JobPosting;
  question: EssayQuestion;
  planItem: EssayPlanItem;
  episodes: ExperienceEpisode[];
  facts: FactItem[];
  styleReferences: EssayArchiveItem[];
  constraints: WritingConstraints;
  freeForm: boolean;
}): Promise<DraftPayload> {
  const limitNote =
    params.question.charLimit > 0
      ? `글자 수 제한: ${params.question.charLimit}자 (${params.question.countSpaces ? "공백 포함" : "공백 제외"}). 초안은 제한의 85~100% 분량으로 작성.`
      : "글자 수 제한 없음";

  const freeFormHint = params.freeForm
    ? "\n국내 기업 표준 자소서 항목(성장과정·성격 장단점·지원동기·직무역량/경험·입사 후 포부) 관행과 평가 목적에 맞게 쓰세요."
    : "";

  const allowedEpisodeIds = [
    params.planItem.primaryEpisodeId,
    params.planItem.secondaryEpisodeId,
  ].filter((id): id is string => Boolean(id));

  const result = await llmJson<DraftPayload>({
    route: "quality",
    stage: "draft",
    system: `${DRAFT_SYSTEM}${freeFormHint}`,
    responseSchema: DRAFT_OUTPUT_SCHEMA,
    user: JSON.stringify({
      mode: params.freeForm ? "freeFormStandardKR" : "customQuestions",
      candidateName: params.profile.name,
      job: {
        company: params.job.company,
        role: params.job.role,
        keywords: params.job.keywords.slice(0, 12),
        requirements: params.job.requirements.slice(0, 8),
        preferred: params.job.preferred.slice(0, 6),
      },
      question: {
        title: params.question.title,
        prompt: params.question.prompt,
      },
      intent: params.planItem.intent,
      plan: {
        thesis: params.planItem.thesis,
        notes: params.planItem.notes,
        targetJdSignals: params.planItem.targetJdSignals,
        primaryEpisodeId: params.planItem.primaryEpisodeId ?? null,
        secondaryEpisodeId: params.planItem.secondaryEpisodeId ?? null,
      },
      selectedEpisodes:
        params.episodes.map(formatEpisode).join("\n") || "(지정 경험 없음)",
      allowedFacts: lockedFacts(params.facts).map((f) => ({
        id: f.id,
        label: f.label,
        value: f.value,
      })),
      styleReferences: (() => {
        const formatted = formatStyleReferencesForDraft(params.styleReferences);
        return formatted.length > 0
          ? formatted
          : "(문체 참고 없음 — 담백·구체적으로)";
      })(),
      constraints: constraintLines(params.constraints),
      limitNote,
      writingBrief: [
        "문항이 묻는 것에만 답한다.",
        params.planItem.thesis,
        allowedEpisodeIds.length
          ? "지정된 경험만 깊게 쓴다. Fact로 제3 경험을 끌어오지 않는다."
          : "경험 소재가 없으면 방향·직무 연결로 답하고 없는 경험을 만들지 않는다.",
        "allowedFacts locked 수치만 사용한다.",
        "JobPosting은 회사 요구사항이다. 지원자 보유 사실로 바꾸지 않는다.",
        "styleReferences는 문체·문단 구조·정보 밀도·두괄식·전환만 참고한다. 그 안의 회사·직무·경험·수치·자격·사실은 쓰지 않는다.",
      ],
    }),
    maxTokens: 4500,
  });

  return {
    body: (result.body ?? "").trim(),
    usedEpisodeIds: result.usedEpisodeIds ?? [],
    usedFactIds: result.usedFactIds ?? [],
  };
}

async function reviseDraft(params: {
  body: string;
  question: EssayQuestion;
  job: JobPosting;
  planItem: EssayPlanItem;
  episodes: ExperienceEpisode[];
  facts: FactItem[];
  styleReferences: EssayArchiveItem[];
  issues: EssayValidationIssue[];
}): Promise<DraftPayload> {
  const limit =
    params.question.charLimit > 0
      ? `${params.question.charLimit}자 (${params.question.countSpaces ? "공백 포함" : "공백 제외"})`
      : "제한 없음";
  const current = countChars(params.body, params.question.countSpaces);

  const result = await llmJson<DraftPayload>({
    route: "quality",
    stage: "revise",
    system: `한국어 자소서 부분 수정기입니다.
${KOREAN_ONLY_RULE}
처음부터 새로 쓰지 않는다. 좋은 문장·사실·수치는 유지하고, 아래 issue만 고친다.
Fact source는 selected episodes + allowed locked Facts 뿐이다.
styleReferences는 문체 참고용이며 사실 source가 아니다.
본문 JSON만 반환한다.`,
    responseSchema: DRAFT_OUTPUT_SCHEMA,
    user: JSON.stringify({
      charLimit: limit,
      currentCharCount: current,
      issues: params.issues.map((i) => `${i.severity}:${i.code} ${i.message}`),
      plan: {
        thesis: params.planItem.thesis,
        primaryEpisodeId: params.planItem.primaryEpisodeId ?? null,
        secondaryEpisodeId: params.planItem.secondaryEpisodeId ?? null,
        allowedFactIds: params.planItem.allowedFactIds,
      },
      allowedFacts: lockedFacts(params.facts).map((f) => ({
        id: f.id,
        label: f.label,
        value: f.value,
      })),
      selectedEpisodes: params.episodes.map(formatEpisode),
      styleReferences: formatStyleReferencesForDraft(params.styleReferences),
      job: { company: params.job.company, role: params.job.role },
      draft: params.body,
    }),
    maxTokens: 4500,
  });

  return {
    body: (result.body ?? "").trim() || params.body,
    usedEpisodeIds: result.usedEpisodeIds ?? [],
    usedFactIds: result.usedFactIds ?? [],
  };
}

function planItemForQuestion(
  plan: EssayPlan | undefined,
  questionId: string,
): EssayPlanItem | undefined {
  return plan?.items.find((i) => i.questionId === questionId);
}

function applyProvenance(
  draft: DraftPayload,
  allowedEpisodeIds: string[],
  allowedFactIds: string[],
): {
  usedEpisodeIds: string[];
  usedFactIds: string[];
  issues: EssayValidationIssue[];
} {
  const llmEps = draft.usedEpisodeIds.length
    ? draft.usedEpisodeIds
    : allowedEpisodeIds;
  const llmFacts = draft.usedFactIds;
  return clampProvenance({
    usedEpisodeIds: llmEps,
    usedFactIds: llmFacts,
    allowedEpisodeIds,
    allowedFactIds,
  });
}

export async function generateEssays(params: {
  profile: CandidateProfile;
  job: JobPosting;
  setup: SetupConfig;
  personas?: HiringPersona[];
  onlyQuestionId?: string;
  previousPlan?: EssayPlan;
}): Promise<GenerateResult> {
  const personas = params.personas ?? [];

  const allQuestions = params.setup.questions;
  const questions = params.onlyQuestionId
    ? allQuestions.filter((q) => q.id === params.onlyQuestionId)
    : allQuestions;

  if (!questions.length) {
    throw new Error("생성할 문항이 없습니다.");
  }

  const factMaster = await loadFactMaster();
  const reusePlan =
    params.onlyQuestionId &&
    planItemForQuestion(params.previousPlan, params.onlyQuestionId);

  let plan: EssayPlan;
  if (reusePlan && params.previousPlan) {
    plan = params.previousPlan;
  } else {
    const intentStarted = Date.now();
    const intents = await analyzeQuestionIntents({
      job: params.job,
      questions,
    });
    timingLog("intent", { durationMs: Date.now() - intentStarted });
    const rankings: Record<string, ReturnType<typeof rankEpisodesForQuestion>> =
      {};
    const priorPrimaryEpisodeIds: string[] = [];
    if (params.previousPlan && params.onlyQuestionId) {
      for (const item of params.previousPlan.items) {
        if (item.questionId !== params.onlyQuestionId && item.primaryEpisodeId) {
          priorPrimaryEpisodeIds.push(item.primaryEpisodeId);
        }
      }
    }
    for (const q of questions) {
      const intent =
        intents.find((i) => i.questionId === q.id) ??
        fallbackIntent(q, params.job);
      rankings[q.id] = rankEpisodesForQuestion({
        profile: params.profile,
        job: params.job,
        question: q,
        intent,
      });
    }
    const built = buildEssayPlan({
      job: params.job,
      questions,
      intents,
      rankings,
      episodes: params.profile.experiences,
      factMaster,
      priorPrimaryEpisodeIds,
    });
    if (params.onlyQuestionId && params.previousPlan?.items.length) {
      const map = new Map(
        params.previousPlan.items.map((i) => [i.questionId, i]),
      );
      for (const item of built.items) map.set(item.questionId, item);
      plan = { items: [...map.values()] };
    } else {
      plan = built;
    }
  }

  async function mapPool<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        results[idx] = await fn(items[idx]);
      }
    }
    const n = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  }

  async function writeOne(question: EssayQuestion): Promise<EssayAnswer> {
    const questionN = questions.indexOf(question) + 1;
    setTimingQuestion(questionN);
    const planItem: EssayPlanItem =
      planItemForQuestion(plan, question.id) ??
      buildEssayPlan({
        job: params.job,
        questions: [question],
        intents: [fallbackIntent(question, params.job)],
        rankings: { [question.id]: [] },
        episodes: params.profile.experiences,
        factMaster,
      }).items[0] ?? {
        questionId: question.id,
        intent: fallbackIntent(question, params.job),
        allowedFactIds: [],
        targetJdSignals: [],
        thesis: `${question.title}: 문항 취지에 맞게 답한다`,
        notes: ["주 소재 없음 (적합 경험 미선택)"],
      };

    const allowedEpisodeIds = [
      planItem.primaryEpisodeId,
      planItem.secondaryEpisodeId,
    ].filter((id): id is string => Boolean(id));
    const episodes = params.profile.experiences.filter((e) =>
      allowedEpisodeIds.includes(e.id),
    );
    const facts = factMaster.facts.filter(
      (f) => f.status === "locked" && planItem.allowedFactIds.includes(f.id),
    );
    const styleReferences = retrieveEssaysForQuestion({
      archive: params.profile.essayArchive,
      job: params.job,
      question,
      intent: planItem.intent,
      planItem,
    });

    const draftStarted = Date.now();
    const draft = await draftOne({
      profile: params.profile,
      job: params.job,
      question,
      planItem,
      episodes,
      facts,
      styleReferences,
      constraints: params.setup.constraints,
      freeForm: Boolean(params.setup.freeForm),
    });
    timingLog(`question=${questionN}`, {
      stage: "draft",
      durationMs: Date.now() - draftStarted,
    });
    const draftLlm = getLastLlmCall();

    const allowedTerms = collectAllowedTerms({
      job: params.job,
      episodes,
      facts,
      extra: [question.title, question.prompt],
    });

    let provenance = applyProvenance(
      draft,
      allowedEpisodeIds,
      planItem.allowedFactIds,
    );
    let body = draft.body;
    let validation = validateEssay({
      body,
      question,
      job: params.job,
      selectedEpisodes: episodes,
      allEpisodes: params.profile.experiences,
      facts,
      allowedTerms,
      provenanceIssues: provenance.issues,
    });

    let revised = false;
    if (validation.issues.some((i) => i.severity === "error")) {
      const reviseStarted = Date.now();
      const rev = await reviseDraft({
        body,
        question,
        job: params.job,
        planItem,
        episodes,
        facts,
        styleReferences,
        issues: validation.issues,
      });
      timingLog("revise", {
        question: questionN,
        durationMs: Date.now() - reviseStarted,
      });
      provenance = applyProvenance(
        rev,
        allowedEpisodeIds,
        planItem.allowedFactIds,
      );
      body = rev.body;
      validation = validateEssay({
        body,
        question,
        job: params.job,
        selectedEpisodes: episodes,
        allEpisodes: params.profile.experiences,
        facts,
        allowedTerms,
        provenanceIssues: provenance.issues,
      });
      revised = true;
    }

    if (
      question.charLimit > 0 &&
      !isWithinLimit(body, question.charLimit, question.countSpaces)
    ) {
      body = clipToCharLimit(body, question.charLimit, question.countSpaces);
      validation = validateEssay({
        body,
        question,
        job: params.job,
        selectedEpisodes: episodes,
        allEpisodes: params.profile.experiences,
        facts,
        allowedTerms,
        provenanceIssues: provenance.issues,
      });
    }

    const charCount = countChars(body, question.countSpaces);
    const constraintNotes = [
      ...validation.issues.map((i) => i.message),
      ...(!planItem.primaryEpisodeId ? ["지정된 경험 소재 없음"] : []),
    ];

    console.info("[essay] diagnose", {
      questionId: question.id,
      questionType: planItem.intent.questionType,
      primary: planItem.primaryEpisodeId ?? null,
      secondary: planItem.secondaryEpisodeId ?? null,
      allowedFactIds: planItem.allowedFactIds,
      retrievedEssayIds: styleReferences.map((r) => r.id),
      usedEpisodeIds: provenance.usedEpisodeIds,
      usedFactIds: provenance.usedFactIds,
      revised,
      validation: {
        valid: validation.valid,
        codes: validation.issues.map((i) => i.code),
      },
      llm: draftLlm,
      charCount,
    });

    return {
      questionId: question.id,
      title: question.title,
      prompt: question.prompt,
      body,
      charCount,
      charLimit: question.charLimit,
      countSpaces: question.countSpaces,
      withinLimit:
        question.charLimit <= 0 ||
        isWithinLimit(body, question.charLimit, question.countSpaces),
      constraintNotes,
      usedEpisodeIds: provenance.usedEpisodeIds,
      usedFactIds: provenance.usedFactIds,
      retrievedEssayIds: styleReferences.map((r) => r.id),
      revised,
      validation,
    };
  }

  const answers = await mapPool(questions, 2, writeOne);

  const matchingNotes = plan.items.flatMap((item) => {
    const q = allQuestions.find((x) => x.id === item.questionId);
    const head = q ? `${q.title}: ` : "";
    return item.notes.map((n) => `· ${head}${n}`);
  });

  return {
    personas,
    answers,
    matchingNotes,
    personaFeedback: "",
    plan,
  };
}
