import { llmText } from "../llm";

/** 프롬프트에 항상 넣는 한글 전용 규칙 (고정) */
export const KOREAN_ONLY_RULE = `언어(필수·위반 금지):
- 본문은 반드시 한국어(한글)로만 작성한다.
- 중국어 한자, 일본어(히라가나·가타카나·한자), 베트남어, 그 외 외국어 문장·단어를 절대 섞지 않는다.
- 금지 예: 商品, 市場, 数据, 新しい, を行い, tham gia, khách, kinh nghiệm, thus, planlessness
- 허용: 한글, 숫자, 문장부호, 공백, 그리고 널리 쓰이는 영문 약어만(예: SNS, OEM, CRM, B2C). 영문 약어도 문장 전체를 영어로 쓰지 말 것.
- 회사명·포지션명은 입력된 한글 표기를 정확히 유지한다.`;

/** CJK 한자 / 일본어 가나 / 베트남어 확장 문자 */
const FOREIGN_SCRIPT_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]|[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/g;

/** 영문 약어로 허용할 짧은 토큰 (대문자/혼용) */
const ALLOWED_LATIN_TOKEN =
  /^(SNS|OEM|ODM|CRM|B2B|B2C|D2C|IT|UI|UX|AI|API|KPI|OKR|PM|PO|QA|SEO|SEM|ROI|CTR|CVR|SKU|MVP|GTM|HR|CX|SCM)$/i;

function latinWordIssues(text: string): string[] {
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const bad: string[] = [];
  for (const w of words) {
    if (ALLOWED_LATIN_TOKEN.test(w)) continue;
    // 회사명 등이 모두 대문자/고유명사일 수 있어 소문자 혼합·긴 영단어만 문제 처리
    if (w.length >= 4 || /[a-z]/.test(w)) {
      bad.push(w);
    }
  }
  return [...new Set(bad)].slice(0, 20);
}

export function findNonKoreanIssues(text: string): string[] {
  const scripts = [...new Set(text.match(FOREIGN_SCRIPT_RE) ?? [])];
  const latin = latinWordIssues(text);
  return [...scripts, ...latin];
}

export function hasNonKoreanScript(text: string): boolean {
  return findNonKoreanIssues(text).length > 0;
}

/**
 * 한글 외 문자 검출 시 재작성. 최대 attempts회.
 * 그래도 남으면 마지막 본문을 반환하되, 호출측에서 notes로 알릴 수 있음.
 */
export async function enforceKoreanOnly(params: {
  body: string;
  company: string;
  role: string;
  questionTitle: string;
}): Promise<{ body: string; rewritten: boolean; remainingIssues: string[] }> {
  let text = params.body.trim();
  let rewritten = false;

  for (let i = 0; i < 3; i++) {
    const issues = findNonKoreanIssues(text);
    if (!issues.length) {
      return { body: text, rewritten, remainingIssues: [] };
    }

    rewritten = true;
    const fixed = await llmText({
      route: "quality",
      system: `당신은 한국어 교정기입니다.
${KOREAN_ONLY_RULE}
입력 글의 의미·수치·사실·회사명 표기는 유지하되, 외국어·한자·가나·베트남어가 섞인 부분만 자연스러운 한국어로 바꿔 전체 본문을 다시 씁니다.
본문만 출력하세요. 설명 금지.`,
      user: [
        `회사명(정확히 유지): ${params.company}`,
        `포지션(정확히 유지): ${params.role}`,
        `문항: ${params.questionTitle}`,
        `검출된 문제 표기: ${issues.join(" · ")}`,
        "",
        "아래 글을 한국어만 사용하도록 전면 재작성하세요:",
        text,
      ].join("\n"),
      maxTokens: 3500,
    });

    const next = fixed.trim();
    if (next) text = next;
  }

  return {
    body: text,
    rewritten,
    remainingIssues: findNonKoreanIssues(text),
  };
}
