import { llmJson, llmText } from "../llm";
import { countChars, isWithinLimit } from "./charCount";
import { selectEpisodes } from "./match";
import { buildPersonas } from "./personas";
import type {
  CandidateProfile,
  EssayAnswer,
  EssayQuestion,
  GenerateResult,
  HiringPersona,
  JobPosting,
  SetupConfig,
  WritingConstraints,
} from "../types";

/** 톤·품질 규칙은 항상 적용 (UI에서 고정) */
const BASE_CONSTRAINTS = [
  "구체적 수치(지표)를 최소 1개 이상 포함",
  "지원 회사명·포지션을 자연스럽게 언급",
  "존댓말·격식체 사용",
  "제공된 경험 외 사실 날조 금지",
];

function constraintLines(c: WritingConstraints): string[] {
  const lines: string[] = [...BASE_CONSTRAINTS];
  if (c.freeText.trim()) lines.push(c.freeText.trim());
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
      ? `글자 수 제한: ${params.question.charLimit}자 (${params.question.countSpaces ? "공백 포함" : "공백 제외"})`
      : "글자 수 제한 없음";

  const freeFormHint = params.freeForm
    ? "\n국내 기업 표준 자소서 항목(성장과정·성격 장단점·지원동기·직무역량/경험·입사 후 포부) 관행에 맞게, 해당 항목의 평가 목적에 충실한 구조로 작성하세요."
    : "";

  const result = await llmJson<{
    body: string;
    usedEpisodeIds: string[];
  }>({
    system: `당신은 한국어 자기소개서 전문 라이터입니다.
지원자 실제 경험만 사용해 문항별 답변을 작성합니다.
채용 담당 페르소나들의 심사 포인트를 반영하되, 과도한 미사여구는 피합니다.
본문은 복사해 바로 붙여넣을 수 있는 완성된 문장으로만 작성합니다.${freeFormHint}`,
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
        portfolioUrl: params.profile.portfolioUrl,
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
      personas: params.personas,
      selectedEpisodes: params.episodesSummary,
      pastEssaySamples: params.essaySamples,
      question: {
        title: params.question.title,
        prompt: params.question.prompt,
      },
      constraints: constraintLines(params.constraints),
      limitNote,
      outputSchema: {
        body: "완성된 자소서 본문 문자열",
        usedEpisodeIds: "사용한 에피소드 id 배열",
      },
    }),
    maxTokens: 2500,
  });

  return {
    body: (result.body ?? "").trim(),
    usedEpisodeIds: result.usedEpisodeIds ?? [],
  };
}

async function compressToLimit(
  body: string,
  question: EssayQuestion,
): Promise<string> {
  if (question.charLimit <= 0 || isWithinLimit(body, question.charLimit, question.countSpaces)) {
    return body;
  }

  const compressed = await llmText({
    system: "한국어 자소서 문장을 의미 유지하며 압축합니다. 본문만 출력하세요.",
    user: `다음 글을 ${question.charLimit}자 ${question.countSpaces ? "(공백 포함)" : "(공백 제외)"} 이내로 압축하세요.\n\n${body}`,
    maxTokens: 2000,
  });

  let text = compressed.trim();
  // Hard trim fallback if still over
  for (let i = 0; i < 3 && !isWithinLimit(text, question.charLimit, question.countSpaces); i++) {
    const extra = await llmText({
      system: "더 짧게. 본문만.",
      user: `목표 ${question.charLimit}자. 현재 ${countChars(text, question.countSpaces)}자.\n\n${text}`,
      maxTokens: 1600,
    });
    text = extra.trim();
  }

  if (!isWithinLimit(text, question.charLimit, question.countSpaces)) {
    // character-wise trim (Unicode aware)
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
  const episodesSummary = episodes
    .map(
      (e) =>
        `- id=${e.id} | ${e.title} | tags=${e.tags.join(",")}\n  ${e.highlights.join(" / ")}`,
    )
    .join("\n");

  const essaySamples = params.profile.essayArchive
    .slice(0, 4)
    .map(
      (a) =>
        `Q: ${a.question}\nA: ${a.answer.slice(0, 500)}${a.rating ? ` (rating:${a.rating})` : ""}`,
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
    const body = await compressToLimit(draft.body, question);
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
      constraintNotes: checkConstraints(
        body,
        params.setup.constraints,
        params.job.company,
      ),
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
