import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateEssays } from "@/lib/generate/essay";
import { loadCandidateProfile } from "@/lib/profile/loadProfile";
import type { JobPosting, SetupConfig } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const questionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string(),
  charLimit: z.number().int().min(0),
  countSpaces: z.boolean(),
});

const setupSchema = z.object({
  questions: z.array(questionSchema).min(1),
  constraints: z.object({
    freeText: z.string(),
    requireNumbers: z.boolean(),
    mentionCompany: z.boolean(),
    formalTone: z.boolean(),
    noFabrication: z.boolean(),
  }),
});

const jobSchema = z.object({
  company: z.string(),
  role: z.string(),
  requirements: z.array(z.string()),
  preferred: z.array(z.string()),
  responsibilities: z.array(z.string()),
  keywords: z.array(z.string()),
  cultureSignals: z.array(z.string()),
  essayQuestionsHint: z.array(z.string()).optional(),
  rawText: z.string(),
  warnings: z.array(z.string()),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const job = jobSchema.parse(body.job) as JobPosting;
    const setup = setupSchema.parse(body.setup) as SetupConfig;

    // Gate: required fields already enforced by schema (questions min 1)
    for (const q of setup.questions) {
      if (!q.title.trim()) {
        return NextResponse.json(
          { error: "모든 문항의 제목이 필요합니다." },
          { status: 400 },
        );
      }
    }

    const { profile } = await loadCandidateProfile();
    const result = await generateEssays({ profile, job, setup });
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "문항 구성·글자 수·제약 조건을 모두 입력해 주세요.", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "자소서 생성에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
