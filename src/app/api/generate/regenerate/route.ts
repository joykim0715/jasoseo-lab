import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateEssays } from "@/lib/generate/essay";
import { normalizeFreeFormQuestions } from "@/lib/generate/freeForm";
import {
  jobSchema,
  previousResultSchema,
  setupSchema,
} from "@/lib/generate/schemas";
import { loadCandidateProfile } from "@/lib/profile/loadProfile";
import type { EssayPlan, GenerateResult, HiringPersona } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function mergePlan(
  previous?: EssayPlan,
  next?: EssayPlan,
): EssayPlan | undefined {
  if (!previous?.items?.length) return next;
  if (!next?.items?.length) return previous;
  const map = new Map(previous.items.map((i) => [i.questionId, i]));
  for (const item of next.items) map.set(item.questionId, item);
  return { items: [...map.values()] };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const job = jobSchema.parse(body.job);
    let setup = setupSchema.parse(body.setup);
    const questionId = z.string().min(1).parse(body.questionId);
    const personas = (body.personas ?? []) as HiringPersona[];
    const previous = body.previous
      ? (previousResultSchema.parse(body.previous) as GenerateResult)
      : undefined;

    if (setup.freeForm) {
      setup = {
        ...setup,
        freeForm: true,
        questions: normalizeFreeFormQuestions(setup.questions),
      };
    }

    if (!setup.questions.some((q) => q.id === questionId)) {
      return NextResponse.json(
        { error: "재생성할 문항을 찾을 수 없습니다." },
        { status: 400 },
      );
    }

    const { profile } = await loadCandidateProfile();
    const previousPlan = previous?.plan as EssayPlan | undefined;
    const partial = await generateEssays({
      profile,
      job,
      setup,
      personas,
      onlyQuestionId: questionId,
      previousPlan,
    });

    const mergedAnswers = previous?.answers
      ? previous.answers.map((a) => {
          const next = partial.answers.find((p) => p.questionId === a.questionId);
          return next ?? a;
        })
      : partial.answers;

    const plan = mergePlan(previousPlan, partial.plan);
    const matchingNotes = plan?.items.length
      ? plan.items.flatMap((item) => item.notes.map((n) => `· ${n}`))
      : (previous?.matchingNotes ?? partial.matchingNotes);

    const result: GenerateResult = {
      personas: previous?.personas?.length ? previous.personas : partial.personas,
      answers: mergedAnswers,
      matchingNotes,
      personaFeedback: previous?.personaFeedback ?? partial.personaFeedback,
      plan,
    };

    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "재생성 요청이 올바르지 않습니다.",
          details: err.issues,
        },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "재생성에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
