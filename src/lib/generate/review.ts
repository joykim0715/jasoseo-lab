import { defaultPersonas } from "./personas";
import type {
  EssayAnswer,
  HiringPersona,
  JobPosting,
} from "../types";

export type PersonaReview = {
  personas: HiringPersona[];
  notes: string[];
};

/** Draft 입력이 아니라 완성본 검토용. generateEssays는 호출하지 않는다. */
export function buildReviewPersonas(job: JobPosting): HiringPersona[] {
  return defaultPersonas(job);
}

/**
 * Optional reviewer. LLM 호출 없음 — 기본 생성 파이프라인에 붙이지 말 것.
 * 호출부가 생기면 여기서 완성본만 평가한다.
 */
export async function reviewCompletedAnswers(params: {
  job: JobPosting;
  answers: EssayAnswer[];
  personas?: HiringPersona[];
}): Promise<PersonaReview> {
  const personas = params.personas?.length
    ? params.personas
    : buildReviewPersonas(params.job);
  return {
    personas,
    notes: params.answers.length
      ? [`${params.answers.length}개 문항 검토 대기 (자동 호출 없음)`]
      : [],
  };
}
