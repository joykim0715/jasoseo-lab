import type { EssayQuestion } from "../types";

/**
 * 국내 대기업·중견·공기업에서 흔히 쓰는 자기소개서 표준 항목
 * (성장과정 · 성격 장단점 · 지원동기 · 직무역량/경험 · 입사 후 포부)
 * 항목당 중견 기준 500~800자, 공기업 800~1000자 사이를 고려해 기본 800자.
 */
export const FREE_FORM_ITEMS: Omit<EssayQuestion, "id">[] = [
  {
    title: "성장과정",
    prompt:
      "본인의 가치관·인성이 형성된 계기를 중심으로 서술하되, 단순 연대기 나열이 아니라 현재 지원 직무와 연결되는 변화·깨달음을 구체적으로 작성하세요.",
    charLimit: 800,
    countSpaces: true,
  },
  {
    title: "성격의 장단점",
    prompt:
      "장점 1가지와 단점 1가지를 제시하세요. 장점은 직무 수행과 연결하고, 단점은 반드시 인식·개선 노력·현재 변화까지 함께 서술하세요.",
    charLimit: 700,
    countSpaces: true,
  },
  {
    title: "지원동기",
    prompt:
      "이 회사·이 직무를 선택한 이유를 설득하세요. 기업 칭찬만이 아니라, JD 키워드·사업 방향과 본인 경험·역량을 연결해 ‘왜 나인가’를 명확히 하세요.",
    charLimit: 800,
    countSpaces: true,
  },
  {
    title: "직무역량 및 경험",
    prompt:
      "직무와 가장 관련 깊은 경험 1~2개를 STAR(상황-과제-행동-결과)로 깊게 서술하세요. 가능하면 정량 성과(수치·지표)를 포함하고 JD 요구 역량과 매핑하세요.",
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

export function buildFreeFormQuestions(): EssayQuestion[] {
  return FREE_FORM_ITEMS.map((item) => ({
    ...item,
    id: crypto.randomUUID(),
  }));
}

/** 서버(Node)에서도 쓸 수 있는 id 생성 */
export function buildFreeFormQuestionsServer(): EssayQuestion[] {
  return FREE_FORM_ITEMS.map((item, i) => ({
    ...item,
    id: `freeform-${i + 1}-${Date.now()}`,
  }));
}
