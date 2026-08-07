import { llmJson, llmText, SchemaType, type ResponseSchema } from "../llm";
import { countChars, isWithinLimit } from "./charCount";
import { enforceKoreanOnly, KOREAN_ONLY_RULE } from "./koreanOnly";
import { selectEpisodes } from "./match";
import { buildPersonas } from "./personas";
import type {
  CandidateProfile,
  EssayAnswer,
  EssayQuestion,
  ExperienceEpisode,
  GenerateResult,
  HiringPersona,
  JobPosting,
  SetupConfig,
  WritingConstraints,
} from "../types";

/** 톤·품질 규칙은 항상 적용 (UI에서 고정) */
const BASE_CONSTRAINTS = [
  KOREAN_ONLY_RULE,
  "구체적 수치(지표)를 최소 1개 이상 포함",
  "지원 회사명·포지션을 자연스럽게 언급",
  "존댓말·격식체 사용",
  "제공된 경험 외 사실 날조 금지",
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

function checkConstraints(
  body: string,
  _c: WritingConstraints,
  company: string,
): string[] {
  const notes: string[] = [];
  if (!/\d/.test(body)) {
    notes.push("수치 포함 권장 조건 미충족");
  }
  if (company !== "미상" && !body.includes(company)) {
    notes.push("회사명 언급 조건 미충족");
  }
  return notes;
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

const DRAFT_SYSTEM = `당신은 국내 대기업·스타트업 합격 자소서를 다수 작성한 한국어 자기소개서 전문 라이터입니다.

${KOREAN_ONLY_RULE}

작성 원칙:
1) 제공된 경험·지표만 사용. 없는 사실·수치·직함 날조 금지.
2) AI 티 나는 상투어 금지. (예: "~에 기여하고자 합니다" 남발, "열정적인", "다양한 경험")
3) 추상 주장 대신 구체 행동·의사결정·수치·학습을 쓴다.
4) 문단은 2~4개. 각 문단 역할이 분명해야 한다 (핵심→근거→의미/포지션 연결).
5) 채용 페르소나의 선호를 반영하고 레드플래그는 피한다.
6) 존댓말 완결 문장. 복사해 바로 제출 가능한 완성본만 출력.
7) body에는 문단 구분을 \\n\\n 로 넣는다.
8) 중국어·일본어·베트남어·영어 문장을 한 글자도 섞지 않는다.`;

async function draftOne(params: {
  profile: CandidateProfile;
  job: JobPosting;
  question: EssayQuestion;
  personas: HiringPersona[];
  episodesSummary: string;
  essaySamples: string;
  constraints: WritingConstraints;
  freeForm: boolean;
}): Promise<{ body: string; usedEpisodeIds: string[] }> {
  const limitNote =
    params.question.charLimit > 0
      ? `글자 수 제한: ${params.question.charLimit}자 (${params.question.countSpaces ? "공백 포함" : "공백 제외"}). 초안은 제한의 85~100% 분량으로 작성.`
      : "글자 수 제한 없음";

  const freeFormHint = params.freeForm
    ? "\n국내 기업 표준 자소서 항목(성장과정·성격 장단점·지원동기·직무역량/경험·입사 후 포부) 관행과 평가 목적에 맞게 쓰세요."
    : "";

  const result = await llmJson<{
    body: string;
    usedEpisodeIds: string[];
  }>({
    route: "quality",
    system: `${DRAFT_SYSTEM}${freeFormHint}`,
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        body: { type: SchemaType.STRING },
        usedEpisodeIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
      },
      required: ["body", "usedEpisodeIds"],
    } as ResponseSchema,
    user: JSON.stringify({
      mode: params.freeForm ? "freeFormStandardKR" : "customQuestions",
      candidate: {
        name: params.profile.name,
        tagline: params.profile.tagline,
        bio: params.profile.bio,
        about: params.profile.about,
        values: params.profile.values,
        skills: params.profile.skills,
        education: params.profile.education,
        certifications: params.profile.certifications.slice(0, 8),
        works: params.profile.works.slice(0, 6).map((w) => ({
          title: w.title,
          category: w.category,
          description: w.description,
          role: w.role,
          metrics: w.metrics,
          tags: w.tags,
        })),
      },
      job: {
        company: params.job.company,
        role: params.job.role,
        requirements: params.job.requirements,
        preferred: params.job.preferred,
        responsibilities: params.job.responsibilities,
        keywords: params.job.keywords,
        cultureSignals: params.job.cultureSignals,
      },
      personas: params.personas.map((p) => ({
        name: p.name,
        title: p.title,
        focus: p.focus,
        likes: p.likes,
        redFlags: p.redFlags,
        weight: p.weight,
      })),
      selectedEpisodes: params.episodesSummary,
      pastEssaySamples: params.essaySamples || "(과거 자소서 샘플 없음 — 톤은 담백·구체적으로)",
      question: {
        title: params.question.title,
        prompt: params.question.prompt,
      },
      constraints: constraintLines(params.constraints),
      limitNote,
      writingBrief: [
        "문항이 묻는 것에만 집중해 답한다.",
        "경험 1~2개를 깊게 쓰고, 나열식으로 여러 개를 얇게 쓰지 않는다.",
        "마지막에 지원 회사·포지션과의 연결을 한 문장으로 분명히 한다.",
      ],
    }),
    maxTokens: 4500,
  });

  return {
    body: (result.body ?? "").trim(),
    usedEpisodeIds: result.usedEpisodeIds ?? [],
  };
}

/** 초안을 윤문·구체화 (Gemini 우선) */
async function polishBody(params: {
  body: string;
  question: EssayQuestion;
  job: JobPosting;
  constraints: WritingConstraints;
  personas: HiringPersona[];
}): Promise<string> {
  const limitHint =
    params.question.charLimit > 0
      ? `최종 분량은 ${params.question.charLimit}자 ${params.question.countSpaces ? "(공백 포함)" : "(공백 제외)"} 이내.`
      : "";

  const polished = await llmText({
    route: "quality",
    system: `당신은 한국어 자소서 윤문 편집자입니다.
${KOREAN_ONLY_RULE}
사실·수치·고유명사는 유지하고, 문장만 더 날카롭고 자연스럽게 다듬습니다.
상투어·중복·느슨한 연결을 제거하고, 인과와 본인 기여를 선명히 합니다.
외국어·한자·가나가 있으면 한국어로 바꿔 윤문합니다.
본문만 출력하세요. 설명·머리말 금지.`,
    user: [
      `회사: ${params.job.company} / 포지션: ${params.job.role}`,
      `문항: ${params.question.title}`,
      params.question.prompt ? `문항 상세: ${params.question.prompt}` : "",
      `제약: ${constraintLines(params.constraints).join(" · ")}`,
      `심사 포인트: ${params.personas
        .slice(0, 3)
        .map((p) => `${p.title}(${p.focus})`)
        .join(" / ")}`,
      limitHint,
      "",
      "다음 초안을 윤문하세요:",
      params.body,
    ]
      .filter(Boolean)
      .join("\n"),
    maxTokens: 3500,
  });

  return polished.trim() || params.body;
}

async function compressToLimit(
  body: string,
  question: EssayQuestion,
): Promise<string> {
  if (
    question.charLimit <= 0 ||
    isWithinLimit(body, question.charLimit, question.countSpaces)
  ) {
    return body;
  }

  const compressed = await llmText({
    route: "quality",
    system: `한국어 자소서 문장을 의미·수치·본인 기여를 유지하며 압축합니다.
${KOREAN_ONLY_RULE}
본문만 출력하세요.`,
    user: `다음 글을 ${question.charLimit}자 ${question.countSpaces ? "(공백 포함)" : "(공백 제외)"} 이내로 압축하세요. 핵심 성과와 인과는 남기세요. 한글만 사용하세요.\n\n${body}`,
    maxTokens: 2500,
  });

  let text = compressed.trim();
  for (
    let i = 0;
    i < 2 && !isWithinLimit(text, question.charLimit, question.countSpaces);
    i++
  ) {
    const extra = await llmText({
      route: "quality",
      system: `더 짧게. 핵심만. 한글만. 본문만.\n${KOREAN_ONLY_RULE}`,
      user: `목표 ${question.charLimit}자. 현재 ${countChars(text, question.countSpaces)}자.\n\n${text}`,
      maxTokens: 2000,
    });
    text = extra.trim();
  }

  if (!isWithinLimit(text, question.charLimit, question.countSpaces)) {
    const chars = [...text];
    if (question.countSpaces) {
      text = chars.slice(0, question.charLimit).join("");
    } else {
      let count = 0;
      let out = "";
      for (const ch of chars) {
        if (/\s/.test(ch)) {
          out += ch;
        } else {
          if (count >= question.charLimit) break;
          out += ch;
          count += 1;
        }
      }
      text = out;
    }
  }

  return text;
}

export async function generateEssays(params: {
  profile: CandidateProfile;
  job: JobPosting;
  setup: SetupConfig;
  personas?: HiringPersona[];
  onlyQuestionId?: string;
}): Promise<GenerateResult> {
  const personas = params.personas?.length
    ? params.personas
    : await buildPersonas(params.job);

  const { episodes, notes } = selectEpisodes(params.profile, params.job);
  const episodesSummary = episodes.map(formatEpisode).join("\n");

  const essaySamples = params.profile.essayArchive
    .slice(0, 4)
    .map(
      (a) =>
        `Q: ${a.question}\nA: ${a.answer.slice(0, 700)}${a.rating ? ` (rating:${a.rating})` : ""}`,
    )
    .join("\n---\n");

  const questions = params.onlyQuestionId
    ? params.setup.questions.filter((q) => q.id === params.onlyQuestionId)
    : params.setup.questions;

  if (!questions.length) {
    throw new Error("생성할 문항이 없습니다.");
  }

  const answers: EssayAnswer[] = [];

  for (const question of questions) {
    const draft = await draftOne({
      profile: params.profile,
      job: params.job,
      question,
      personas,
      episodesSummary,
      essaySamples,
      constraints: params.setup.constraints,
      freeForm: Boolean(params.setup.freeForm),
    });

    let body = draft.body;
    try {
      body = await polishBody({
        body,
        question,
        job: params.job,
        constraints: params.setup.constraints,
        personas,
      });
    } catch (err) {
      console.warn("[essay] polish skipped:", err);
    }

    body = await compressToLimit(body, question);

    // 고정: 한글 외 문자 검출 → 재작성 (파이프라인 필수 단계)
    let koreanNotes: string[] = [];
    try {
      let enforced = await enforceKoreanOnly({
        body,
        company: params.job.company,
        role: params.job.role,
        questionTitle: question.title,
      });
      body = enforced.body;
      // 재작성으로 분량 초과 시 압축 후 한글 검사 한 번 더
      if (
        question.charLimit > 0 &&
        !isWithinLimit(body, question.charLimit, question.countSpaces)
      ) {
        body = await compressToLimit(body, question);
        enforced = await enforceKoreanOnly({
          body,
          company: params.job.company,
          role: params.job.role,
          questionTitle: question.title,
        });
        body = enforced.body;
      }
      if (enforced.remainingIssues.length) {
        koreanNotes = [
          `한글 외 표기 잔존: ${enforced.remainingIssues.slice(0, 8).join(", ")}`,
        ];
      }
    } catch (err) {
      console.warn("[essay] korean-only enforce failed:", err);
      koreanNotes = ["한글 전용 교정에 실패했습니다. 문항을 다시 생성해 주세요."];
    }

    const charCount = countChars(body, question.countSpaces);
    answers.push({
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
      constraintNotes: [
        ...checkConstraints(
          body,
          params.setup.constraints,
          params.job.company,
        ),
        ...koreanNotes,
      ],
      usedEpisodeIds: draft.usedEpisodeIds,
    });
  }

  const personaFeedback = personas
    .map(
      (p) =>
        `【${p.name} · ${p.title}】(가중 ${p.weight})\n초점: ${p.focus}\n선호: ${p.likes.join(", ")}\n레드플래그: ${p.redFlags.join(", ")}`,
    )
    .join("\n\n");

  return {
    personas,
    answers,
    matchingNotes: notes,
    personaFeedback,
  };
}
