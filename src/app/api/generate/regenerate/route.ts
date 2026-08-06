import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateEssays } from "@/lib/generate/essay";
import { loadCandidateProfile } from "@/lib/profile/loadProfile";
import type { GenerateResult, HiringPersona, JobPosting, SetupConfig } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const job = body.job as JobPosting;
    const setup = body.setup as SetupConfig;
    const questionId = z.string().min(1).parse(body.questionId);
    const personas = (body.personas ?? []) as HiringPersona[];
    const previous = body.previous as GenerateResult | undefined;

    if (!setup?.questions?.length) {
      return NextResponse.json(
        { error: "문항 구성이 필요합니다." },
        { status: 400 },
      );
    }

    const { profile } = await loadCandidateProfile();
    const partial = await generateEssays({
      profile,
      job,
      setup,
      personas,
      onlyQuestionId: questionId,
    });

    const mergedAnswers = previous?.answers
      ? previous.answers.map((a) => {
          const next = partial.answers.find((p) => p.questionId === a.questionId);
          return next ?? a;
        })
      : partial.answers;

    const result: GenerateResult = {
      personas: previous?.personas?.length ? previous.personas : partial.personas,
      answers: mergedAnswers,
      matchingNotes: previous?.matchingNotes ?? partial.matchingNotes,
      personaFeedback: previous?.personaFeedback ?? partial.personaFeedback,
    };

    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "재생성에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
