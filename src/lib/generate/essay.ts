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
  formatDraftReferenceCues,
  formatStyleReferencesForDraft,
  retrieveEssaysForQuestion,
} from "./retrieveEssays";
import { clampProvenance, validateEssay } from "./validateEssay";
import { loadFactMaster } from "../profile/loadFactMaster";
import {
  classifyLlmError,
  paceGroqIfNeeded,
  recoverReviseBody,
  setTimingQuestion,
  timingLog,
  USER_LLM_BUSY,
  UserLlmBusyError,
} from "../llmResilience";
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
      "구성: 경험 서술이 필요하면 상황, 판단, 행동, 확인된 결과 순으로 쓴다. 문항에 맞지 않는 요소는 넣지 않는다.",
    );
  }
  if (c.leadWithPoint) {
    lines.push(
      "구성: 첫 문단에서 이 문항의 답이 보이게 한다. 첫 문장 유형은 작성 카드를 따른다.",
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

const DRAFT_SYSTEM = `당신은 아래 질문에 답하는 지원자의 자기소개서를 작성한다.

${KOREAN_ONLY_RULE}

역할 분리:
- Fact source = selected ExperienceEpisode + allowed locked Facts 만.
- Style source = styleReferences (문단 역할·판단 전환·리듬만).
- Job source = JobPosting (회사 요구. 지원자 보유 사실이 아님).
- Writing strategy = QuestionIntent + EssayPlan + 이 문항의 작성 카드.

작성 원칙:
1) 없는 사실·수치·대화·감정·원인 금지. reference/disabled Fact 사용 금지.
2) body는 \\n\\n 로 문단 구분. 문단 수는 고정하지 않는다.
3) 존댓말 완결 문장. 바로 제출 가능한 완성본만.
4) 한글만. 허용된 도구·자격 고유명사는 유지.
5) EssayPlan thesis·지정 경험만 깊게. 제3 경험 금지.
6) JD의 요구·우대(운전·자격·제품 경험 등)를 지원자 보유 사실로 쓰지 않는다.
7) styleReferences 안의 회사명·직무명·경험·수치·자격·사실은 현재 답변의 사실 source가 아니다. 구조와 리듬만 참고한다.
8) 출력 JSON 키는 body(비어 있지 않은 한국어 본문), usedEpisodeIds, usedFactIds. 본문은 반드시 body 문자열에 넣는다.`;

const DRAFT_WRITING_RULES = [
  "질문이 요구한 내용을 모두 답한다.",
  "제공된 사실 밖의 경험, 수치, 대화, 감정, 원인을 만들지 않는다.",
  "참고 자소서에 없다는 이유로 전달된 경험을 지우거나 부정하지 않는다.",
  "지원동기를 역량 설명으로 대체하지 않는다.",
  "다른 회사나 제품 정보를 섞지 않는다.",
  "묻지 않은 경험 부족을 먼저 고백하지 않는다.",
  "첫 문단에서 답변의 방향이 드러나게 한다.",
  "경험은 필요한 상황, 본인 판단, 구체 행동, 확인된 결과 순으로 풀되 문항에 맞지 않는 요소를 억지로 추가하지 않는다.",
  "판단은 무엇을 보고 어떤 선택을 했는지 보여준다.",
  "행동에는 대상, 방법 또는 바꾼 내용을 포함한다.",
  "숫자와 도구는 해당 문장의 주장을 증명할 때만 사용한다.",
  "본인 행동과 팀·기관의 결과를 구분한다.",
  "회사 정보는 지원 이유를 설명하는 데 필요한 만큼만 사용한다.",
  "실제 경험과 입사 후 할 일을 시제로 구분한다.",
  "포부는 구체 업무 행동과 산출물로 쓴다.",
  "다른 문항의 같은 설명·수치 묶음·교훈을 반복하지 않는다.",
  "참고 예시에서는 구조와 리듬만 참고한다.",
  "문장 길이를 균일하게 맞추지 않는다.",
  "내용 없는 자기평가나 앞 문단의 반복 요약으로 끝내지 않는다.",
].join("\n");

const DRAFT_RHYTHM = [
  "설명 문장을 유지하고, 판단이 바뀌는 지점에만 짧은 문장을 둔다.",
  "경험은 했습니다, 판단은 생각했습니다 또는 판단했습니다, 포부는 하겠습니다. 어미를 억지로 바꾸지 않는다.",
  "처음에는, 하지만, 이후, 그 결과는 관점이 바뀔 때만 쓴다.",
  "고도화, 시너지, 기여를 문단마다 반복하지 않는다.",
  "소제목은 선택이다. 모든 문항에 광고 문장처럼 넣지 않는다.",
].join(" ");

const QUESTION_SHOULD: Record<string, string> = {
  motivation:
    "소재는 질문 적합성과 실제 행동 증거로 고른다. 무엇을 보고 기존 생각을 바꿨는지 보여준다. 다른 문항의 성과 수치 묶음을 여기로 가져오지 않는다.",
  competency:
    "판단의 전환을 드러낸다. 숫자에는 규모, 기준, 변화, 결과 중 하나의 역할을 부여한다. 도구와 자격보다 수행한 일을 앞세운다. 검증된 업무 방식을 지원 직무로 옮기되 직접 경험처럼 쓰지 않는다.",
  growth:
    "태도가 바뀐 사건을 보여준다. 역량 문항과 같은 성과 나열을 반복하지 않는다.",
  personality:
    "반복되는 행동과 그 행동이 만든 비용을 쓴다. 근거 없는 자기평가를 반복하지 않는다.",
  aspiration:
    "초기 업무 행동과 산출물부터 쓴다. 배우고 성장하겠다는 문장만으로 끝내지 않는다.",
  collaboration:
    "누구와 무엇을 맞췄는지 쓴다. 팀 결과와 개인 행동을 구분한다.",
  problem_solving:
    "이상 징후를 보고 어떤 기준으로 확인했는지 보여준다. 확인 없이 원인을 단정하지 않는다.",
  challenge:
    "목표와 접근을 바꾼 지점을 쓴다. 개인 목표의 실패를 팀 성과로 덮지 않는다.",
  conflict: "쟁점과 각 입장의 이유를 쓴다. 본인만 합리적인 사람으로 묘사하지 않는다.",
  values: "판단 기준 때문에 선택이 달라진 경험을 쓴다. 인재상 문장을 복사하지 않는다.",
  free_intro:
    "지원 방향과 대표 행동 증거를 쓴다. 같은 프로젝트를 반복 요약하지 않는다.",
  social_issue:
    "변화와 쟁점에 대한 본인 견해를 쓴다. 뉴스 요약만 두지 않는다.",
};

const QUESTION_WRITING_CARDS: Record<string, string> = {
  motivation:
    "지원동기. 구조는 관심·접점, 경험에서 얻은 판단, 회사·직무 선택. 첫 문장은 지원 이유 또는 그 이유가 생긴 출발점. 회사 소개로 시작하지 않는다. 잘할 수 있다는 말만 있고 왜 여기인지는 없게 쓰지 않는다.",
  competency:
    "직무역량. 구조는 핵심 역량, 과제, 판단, 행동, 결과, 적용. 첫 문장은 강점 또는 해결한 문제. 자격증과 도구 나열로 대체하지 않는다. 수치는 많은데 무슨 일을 했는지는 없게 쓰지 않는다.",
  growth:
    "성장과정. 구조는 현재 태도, 형성 사건, 확장이나 변화, 현재 일하는 방식. 첫 문장은 변화의 축 또는 현재 가치관. 연대기로 쓰지 않는다.",
  personality:
    "장단점. 구조는 강점 행동, 사례, 단점의 실제 비용, 보완 방식. 단점을 강점으로 포장하거나 이미 완전히 해결됐다고 쓰지 않는다.",
  aspiration:
    "입사 후 포부. 구조는 초기 파악, 구체 행동과 산출물, 피드백과 개선, 확장. 확인되지 않은 매출이나 점유율 목표는 만들지 않는다.",
  problem_solving:
    "문제해결. 구조는 이상 징후, 확인 기준, 원인 확인, 조치, 결과와 검토. 현장 확인 없이 원인을 단정하지 않는다.",
  challenge:
    "도전. 구조는 목표, 한계, 접근 변경, 실행, 결과, 남은 방식. 실패를 성공으로 바꾸어 쓰지 않는다.",
  collaboration:
    "참고 구조. 협업은 공동 과제, 역할 차이, 본인의 조율 행동, 실행, 공동 결과. 소통했다거나 시너지를 냈다는 말만 두지 않는다.",
  conflict:
    "참고 구조. 갈등은 쟁점, 각 입장의 이유, 공통 판단 자료, 조정, 결과.",
  values:
    "참고 구조. 가치관은 판단 기준, 선택 상황, 실제 행동, 결과, 현재 기준.",
  free_intro:
    "자유 자기소개. 구조는 지원 방향, 대표 경험, 보완 경험, 초기 기여. 지원동기를 빼지 않는다.",
  social_issue:
    "사회 이슈. 구조는 변화, 핵심 쟁점, 자신의 견해, 판단 기준과 대응 방향. 본인 견해 없이 뉴스만 요약하지 않는다.",
};

const CARD_ALIASES: Record<string, string> = {
  strength_weakness: "personality",
  future_plan: "aspiration",
};

export function draftStyleCard(questionType: string): string {
  const raw = questionType.trim() || "general";
  const type = CARD_ALIASES[raw] ?? raw;
  const should = QUESTION_SHOULD[type];
  const card =
    QUESTION_WRITING_CARDS[type] ??
    "이 문항이 묻는 요구에 답한다. 맞지 않는 문항 구조를 억지로 덮지 않는다.";
  return [DRAFT_WRITING_RULES, DRAFT_RHYTHM, should, card]
    .filter(Boolean)
    .join("\n");
}

export function siblingMaterialNotes(
  items: { questionId: string; questionType: string; thesis: string }[],
  questionId: string,
): string[] {
  return items
    .filter((item) => item.questionId !== questionId && item.thesis.trim())
    .slice(0, 6)
    .map((item) => `${item.questionType}: ${item.thesis.trim()}`);
}

type DraftPayload = {
  body: string;
  usedEpisodeIds: string[];
  usedFactIds: string[];
};

export function essayOutputMaxTokens(charLimit: number): number {
  if (!Number.isFinite(charLimit) || charLimit <= 0) return 2200;
  return Math.min(3200, Math.max(1000, Math.round(charLimit * 1.8) + 400));
}

function failedEssayAnswer(question: EssayQuestion): EssayAnswer {
  return {
    questionId: question.id,
    title: question.title,
    prompt: question.prompt,
    body: "",
    charCount: 0,
    charLimit: question.charLimit,
    countSpaces: question.countSpaces,
    withinLimit: true,
    constraintNotes: [USER_LLM_BUSY],
    usedEpisodeIds: [],
    failed: true,
    retryable: true,
  };
}

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
  siblingNotes?: string[];
}): Promise<DraftPayload> {
  const limitNote =
    params.question.charLimit > 0
      ? `글자 수 제한: ${params.question.charLimit}자 (${params.question.countSpaces ? "공백 포함" : "공백 제외"}). 초안은 제한의 85~100% 분량으로 작성.`
      : "글자 수 제한 없음";

  const freeFormHint = params.freeForm
    ? "\n자유 양식 항목(지원동기·힘들었던 경험·장단점·직무 역량·입사 후 포부)이 묻는 바에 맞게 쓰세요."
    : "";

  const allowedEpisodeIds = [
    params.planItem.primaryEpisodeId,
    params.planItem.secondaryEpisodeId,
  ].filter((id): id is string => Boolean(id));

  const styleCard = draftStyleCard(params.planItem.intent.questionType);
  const result = await llmJson<DraftPayload>({
    route: "quality",
    stage: "draft",
    requireBody: true,
    system: `${DRAFT_SYSTEM}${freeFormHint}\n\n문체 카드:\n${styleCard}`,
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
      otherQuestionFocus: params.siblingNotes?.length
        ? params.siblingNotes
        : ["(다른 문항 배분 없음)"],
      selectedEpisodes:
        params.episodes.map(formatEpisode).join("\n") || "(지정 경험 없음)",
      allowedFacts: lockedFacts(params.facts).map((f) => ({
        id: f.id,
        label: f.label,
        value: f.value,
      })),
      styleCard,
      styleReferences: (() => {
        const formatted = formatDraftReferenceCues(params.styleReferences);
        return formatted.length > 0 ? formatted : "(구조 참고 없음)";
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
        "styleCard는 발췌가 없어도 항상 따른다.",
        "otherQuestionFocus와 같은 설명·수치 묶음·교훈을 이 문항에 반복하지 않는다.",
        "styleReferences는 구조와 리듬만 참고한다. 그 안의 회사·직무·경험·수치·자격·사실은 쓰지 않는다.",
      ],
    }),
    maxTokens: essayOutputMaxTokens(params.question.charLimit),
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

  try {
    const result = await llmJson<DraftPayload>({
      route: "quality",
      stage: "revise",
      requireBody: true,
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
      maxTokens: essayOutputMaxTokens(params.question.charLimit),
    });

    return {
      body: recoverReviseBody(params.body, result.body),
      usedEpisodeIds: result.usedEpisodeIds ?? [],
      usedFactIds: result.usedFactIds ?? [],
    };
  } catch (err) {
    if (classifyLlmError(err).kind === "empty_output") {
      return {
        body: recoverReviseBody(params.body, ""),
        usedEpisodeIds: [],
        usedFactIds: [],
      };
    }
    throw err;
  }
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
    await paceGroqIfNeeded(essayOutputMaxTokens(question.charLimit));
    try {
      return await writeOneUnlocked(question, questionN);
    } catch (err) {
      if (params.onlyQuestionId) throw err;
      timingLog("question_failed", {
        question: questionN,
        kind: classifyLlmError(err).kind,
      });
      console.warn("[essay] question failed", {
        questionId: question.id,
        kind: classifyLlmError(err).kind,
      });
      return failedEssayAnswer(question);
    }
  }

  async function writeOneUnlocked(
    question: EssayQuestion,
    questionN: number,
  ): Promise<EssayAnswer> {
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
      siblingNotes: siblingMaterialNotes(
        plan.items.map((item) => ({
          questionId: item.questionId,
          questionType: item.intent.questionType,
          thesis: item.thesis,
        })),
        question.id,
      ),
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

  const answers = await mapPool(questions, 1, writeOne);
  if (answers.length > 0 && answers.every((a) => a.failed)) {
    throw new UserLlmBusyError();
  }

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
