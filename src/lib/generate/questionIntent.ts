import { llmJson, SchemaType, type ResponseSchema } from "../llm";
import type { EssayQuestion, JobPosting, QuestionIntent } from "../types";

const INTENT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    intents: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          questionId: { type: SchemaType.STRING },
          questionType: { type: SchemaType.STRING },
          goals: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          evidencePriorities: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          jdSignals: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          avoid: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
        },
        required: [
          "questionId",
          "questionType",
          "goals",
          "evidencePriorities",
          "jdSignals",
          "avoid",
        ],
      },
    },
  },
  required: ["intents"],
} as ResponseSchema;

export function inferQuestionType(title: string, prompt: string): string {
  const titleHit = classifyIntentText(title);
  if (titleHit) return titleHit;
  return classifyIntentText(`${title} ${prompt}`) ?? "general";
}

function classifyIntentText(t: string): string | null {
  if (/협업|팀워크|갈등|조율|소통/.test(t)) return "collaboration";
  if (/지원\s*동기|지원하게|왜\s*지원|지원\s*이유/.test(t)) return "motivation";
  if (/입사\s*후|포부|향후\s*계획|커리어\s*계획|기여\s*계획/.test(t)) {
    return "aspiration";
  }
  if (/장단점|성격|장점|단점|강점|약점/.test(t)) return "personality";
  if (/힘들었던\s*경험|어려웠던\s*경험/.test(t)) return "challenge";
  if (/성장과정|가치관|형성\s*계기/.test(t)) return "growth";
  if (
    /직무역량|직무\s*역량|직무.{0,8}경험|프로젝트|성과|문제\s*해결/.test(t)
  ) {
    return "competency";
  }
  return null;
}

export function fallbackIntent(
  question: EssayQuestion,
  job: JobPosting,
): QuestionIntent {
  const questionType = inferQuestionType(question.title, question.prompt);
  const jdSignals = [...job.keywords.slice(0, 6), ...job.requirements.slice(0, 4)];
  const byType: Record<
    string,
    Pick<QuestionIntent, "goals" | "evidencePriorities" | "avoid">
  > = {
    growth: {
      goals: ["가치관 형성 계기", "현재 직무와 연결되는 변화"],
      evidencePriorities: ["성장 스토리", "행동 변화"],
      avoid: ["연대기 나열", "검증 안 된 수치 남발"],
    },
    personality: {
      goals: ["장점 1개와 직무 연결", "단점 인식·개선"],
      evidencePriorities: ["구체 협업 사례", "개선 습관"],
      avoid: ["추상 성격 형용사만"],
    },
    challenge: {
      goals: ["막힌 지점", "접근을 바꾼 판단", "그 뒤의 일하는 방식"],
      evidencePriorities: ["한계와 변경", "실행과 결과"],
      avoid: ["실패를 성공담으로 바꾸기", "없는 수치"],
    },
    collaboration: {
      goals: ["협업·조율 과정", "본인 역할과 갈등 해결"],
      evidencePriorities: ["구체 협업 사례", "소통·조율"],
      avoid: ["혼자 한 성과만", "직무 숫자 나열"],
    },
    motivation: {
      goals: ["왜 이 경험이었는지", "왜 이 직무·회사인지"],
      evidencePriorities: ["깨달음", "JD 키워드와의 연결"],
      avoid: ["실행 상세 숫자 나열", "회사 논평"],
    },
    competency: {
      goals: ["직무 관련 경험 1~2개 깊이", "성과와 본인 기여"],
      evidencePriorities: ["STAR", "검증된 수치"],
      avoid: ["경험 얇게 나열", "없는 사실"],
    },
    aspiration: {
      goals: ["1년차 기여", "3~5년 성장 방향"],
      evidencePriorities: ["직무 맥락", "보유 스킬"],
      avoid: ["막연한 다짐"],
    },
    general: {
      goals: ["문항이 묻는 평가 포인트에 답한다"],
      evidencePriorities: ["구체 경험", "직무 연결"],
      avoid: ["문항 이탈"],
    },
  };
  const pack = byType[questionType] ?? byType.general;
  return {
    questionId: question.id,
    questionType,
    goals: pack.goals,
    evidencePriorities: pack.evidencePriorities,
    jdSignals,
    avoid: pack.avoid,
  };
}

function normalizeIntent(
  raw: Partial<QuestionIntent>,
  question: EssayQuestion,
  job: JobPosting,
): QuestionIntent {
  const fallback = fallbackIntent(question, job);
  const llmType = (raw.questionType || "").trim();
  const questionType =
    fallback.questionType === "challenge"
      ? "challenge"
      : llmType || fallback.questionType;
  return {
    questionId: question.id,
    questionType,
    goals: Array.isArray(raw.goals) && raw.goals.length ? raw.goals : fallback.goals,
    evidencePriorities:
      Array.isArray(raw.evidencePriorities) && raw.evidencePriorities.length
        ? raw.evidencePriorities
        : fallback.evidencePriorities,
    jdSignals:
      Array.isArray(raw.jdSignals) && raw.jdSignals.length
        ? raw.jdSignals
        : fallback.jdSignals,
    avoid: Array.isArray(raw.avoid) && raw.avoid.length ? raw.avoid : fallback.avoid,
  };
}

/** 전체 문항 1회 structured LLM 호출. 실패 시 deterministic fallback. */
export async function analyzeQuestionIntents(params: {
  job: JobPosting;
  questions: EssayQuestion[];
}): Promise<QuestionIntent[]> {
  const { job, questions } = params;
  if (!questions.length) return [];

  try {
    const parsed = await llmJson<{ intents: Partial<QuestionIntent>[] }>({
      route: "fast",
      stage: "intent",
      system: `You analyze Korean job-application essay questions in one pass.
For each question return questionId (copy exactly), questionType
(collaboration|growth|personality|motivation|competency|aspiration|challenge|general).
힘들었던 경험은 challenge로 둔다.
goals, evidencePriorities, jdSignals, avoid.
Keep strings short. Korean text fields. No markdown.`,
      user: JSON.stringify({
        job: {
          company: job.company,
          role: job.role,
          requirements: job.requirements.slice(0, 8),
          preferred: job.preferred.slice(0, 6),
          keywords: job.keywords.slice(0, 12),
        },
        questions: questions.map((q) => ({
          questionId: q.id,
          title: q.title,
          prompt: q.prompt,
        })),
      }),
      maxTokens: 2500,
      responseSchema: INTENT_SCHEMA,
    });

    const byId = new Map(
      (parsed.intents ?? []).map((i) => [i.questionId, i]),
    );
    return questions.map((q) =>
      normalizeIntent(byId.get(q.id) ?? { questionId: q.id }, q, job),
    );
  } catch (err) {
    console.warn("[questionIntent] LLM failed — fallback:", err);
    return questions.map((q) => fallbackIntent(q, job));
  }
}
