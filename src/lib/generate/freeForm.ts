import type { EssayQuestion } from "../types";

/**
 * 자유 양식 문항. 순서와 제목은 이 배열이 기준이다.
 * 지원동기 · 힘들었던 경험 · 장단점 · 직무 역량 · 입사 후 포부
 */
export const FREE_FORM_ITEMS: Omit<EssayQuestion, "id">[] = [
  {
    title: "지원동기",
    prompt:
      "이 회사·이 직무를 선택한 이유를 설득하세요. 기업 칭찬만이 아니라, JD 키워드·사업 방향과 본인 경험·역량을 연결해 ‘왜 나인가’를 명확히 하세요.",
    charLimit: 800,
    countSpaces: true,
  },
  {
    title: "힘들었던 경험",
    prompt:
      "힘들었던 경험 하나를 쓰세요. 목표와 막힌 지점, 접근을 바꾼 판단, 실행과 결과, 그 뒤에 남은 일하는 방식을 담으세요. 실패를 성공담으로 바꾸지 마세요.",
    charLimit: 800,
    countSpaces: true,
  },
  {
    title: "장단점",
    prompt:
      "장점 1가지와 단점 1가지를 제시하세요. 장점은 직무 수행과 연결하고, 단점은 반드시 인식·개선 노력·현재 변화까지 함께 서술하세요.",
    charLimit: 700,
    countSpaces: true,
  },
  {
    title: "직무 역량",
    prompt:
      "직무와 가장 관련 깊은 경험 1~2개를 깊게 서술하세요. 가능하면 정량 성과(수치·지표)를 포함하고 JD 요구 역량과 매핑하세요.",
    charLimit: 1000,
    countSpaces: true,
  },
  {
    title: "입사 후 포부",
    prompt:
      "‘열심히 하겠습니다’ 식 다짐 대신, 1년차 적응·기여 → 3~5년 전문성 성장의 구체적 로드맵을 직무·회사 맥락에 맞게 작성하세요.",
    charLimit: 700,
    countSpaces: true,
  },
];

/** 내용의 canonical source는 FREE_FORM_ITEMS. 기존 ID는 index로 유지. */
export function normalizeFreeFormQuestions(
  existingQuestions?: EssayQuestion[],
): EssayQuestion[] {
  return FREE_FORM_ITEMS.map((item, i) => {
    const prevId = existingQuestions?.[i]?.id?.trim();
    return {
      ...item,
      id: prevId || `freeform-${i + 1}`,
    };
  });
}

export function buildFreeFormQuestions(
  existingQuestions?: EssayQuestion[],
): EssayQuestion[] {
  return normalizeFreeFormQuestions(existingQuestions);
}

export function buildFreeFormQuestionsServer(
  existingQuestions?: EssayQuestion[],
): EssayQuestion[] {
  return normalizeFreeFormQuestions(existingQuestions);
}
