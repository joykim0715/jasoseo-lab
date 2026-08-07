import { llmJson, SchemaType, type ResponseSchema } from "../llm";
import type { HiringPersona, JobPosting } from "../types";

const PERSONA_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    personas: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          title: { type: SchemaType.STRING },
          focus: { type: SchemaType.STRING },
          likes: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          redFlags: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          weight: { type: SchemaType.NUMBER },
        },
        required: ["name", "title", "focus", "likes", "redFlags", "weight"],
      },
    },
  },
  required: ["personas"],
} as ResponseSchema;

function defaultPersonas(job: JobPosting): HiringPersona[] {
  const role = job.role && job.role !== "미상" ? job.role : "해당 포지션";
  const company =
    job.company && job.company !== "미상" ? job.company : "지원 기업";
  return [
    {
      id: "persona-1",
      name: "인사 담당",
      title: "HR",
      focus: `${company} 문화 적합성과 성장 가능성`,
      likes: ["구체적 협업 사례", "학습·성장 스토리", "역할 이해"],
      redFlags: ["추상적 미사여구", "경험 과장", "회사·직무 이해 부족"],
      weight: 0.7,
    },
    {
      id: "persona-2",
      name: "현업 리더",
      title: "Hiring Manager",
      focus: `${role} 직무 역량과 문제 해결력`,
      likes: ["수치·성과", "본인 기여 명확성", "실무 도구·프로세스"],
      redFlags: ["역할 모호", "결과 없는 과정 나열", "팀 기여 불명확"],
      weight: 1,
    },
    {
      id: "persona-3",
      name: "실무 시니어",
      title: "Domain Reviewer",
      focus: "업무 깊이·실행력·커뮤니케이션",
      likes: ["의사결정 근거", "트레이드오프 인식", "회고·개선"],
      redFlags: ["기술/경험 나열만", "책임 회피 톤", "검증 불가 주장"],
      weight: 0.8,
    },
  ];
}

function normalizePersonas(
  raw: {
    name?: string;
    title?: string;
    focus?: string;
    likes?: string[];
    redFlags?: string[];
    weight?: number;
  }[],
): HiringPersona[] {
  return raw.slice(0, 4).map((p, i) => ({
    id: `persona-${i + 1}`,
    name: p.name?.trim() || `페르소나 ${i + 1}`,
    title: p.title?.trim() || "Reviewer",
    focus: p.focus?.trim() || "종합 평가",
    likes: Array.isArray(p.likes) ? p.likes.filter(Boolean) : [],
    redFlags: Array.isArray(p.redFlags) ? p.redFlags.filter(Boolean) : [],
    weight: typeof p.weight === "number" ? p.weight : 0.5,
  }));
}

export async function buildPersonas(job: JobPosting): Promise<HiringPersona[]> {
  try {
    const parsed = await llmJson<{
      personas: {
        name: string;
        title: string;
        focus: string;
        likes: string[];
        redFlags: string[];
        weight: number;
      }[];
    }>({
      system: `You design 2-4 hiring reviewer personas for a Korean job posting.
Each persona represents a realistic stakeholder (HR, hiring manager, domain expert, etc.).
weight: 0.1-1.0 relative influence. Respond in Korean for text fields.
Keep each string short (under 80 chars). Avoid quotes inside strings.`,
      user: JSON.stringify({
        company: job.company,
        role: job.role,
        requirements: job.requirements.slice(0, 8),
        preferred: job.preferred.slice(0, 6),
        responsibilities: job.responsibilities.slice(0, 6),
        cultureSignals: job.cultureSignals.slice(0, 6),
        keywords: job.keywords.slice(0, 12),
      }),
      maxTokens: 2500,
      responseSchema: PERSONA_SCHEMA,
    });

    const personas = normalizePersonas(parsed.personas ?? []);
    if (!personas.length) return defaultPersonas(job);
    return personas;
  } catch (err) {
    console.warn("[personas] LLM failed — using default personas:", err);
    return defaultPersonas(job);
  }
}
