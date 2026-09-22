import { llmText } from "../llm";
import type { ExperienceEpisode, FactItem, JobPosting } from "../types";

/** 프롬프트에 항상 넣는 한글 전용 규칙 (고정) */
export const KOREAN_ONLY_RULE = `언어(필수·위반 금지):
- 본문은 반드시 한국어(한글)로만 작성한다.
- 중국어 한자, 일본어(히라가나·가타카나·한자), 베트남어, 그 외 외국어 문장·단어를 절대 섞지 않는다.
- 금지 예: 商品, 市場, 数据, 新しい, を行い, tham gia, khách, kinh nghiệm, thus, planlessness
- 허용: 한글, 숫자, 문장부호, 공백, 그리고 널리 쓰이는 영문 약어만(예: SNS, OEM, CRM, B2C). 영문 약어도 문장 전체를 영어로 쓰지 말 것.
- 회사명·포지션명은 입력된 한글 표기를 정확히 유지한다.
- 입력에 명시된 도구·자격·제품 고유명사(SQL, SPSS, Figma 등)는 그대로 둔다.`;

/** CJK 한자 / 일본어 가나 / 베트남어 확장 문자 */
const FOREIGN_SCRIPT_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]|[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/g;

/** 영문 약어로 허용할 짧은 토큰 (대문자/혼용) */
const ALLOWED_LATIN_TOKEN =
  /^(SNS|OEM|ODM|CRM|B2B|B2C|D2C|IT|UI|UX|AI|API|KPI|OKR|PM|PO|QA|SEO|SEM|ROI|CTR|CVR|SKU|MVP|GTM|HR|CX|SCM)$/i;

const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9.+#-]{1,}/g;

function latinTokensFrom(text: string): string[] {
  return text.match(LATIN_TOKEN_RE) ?? [];
}

export function collectAllowedTerms(params: {
  job: JobPosting;
  episodes: ExperienceEpisode[];
  facts?: FactItem[];
  extra?: string[];
}): string[] {
  const chunks: string[] = [
    params.job.company,
    params.job.role,
    ...params.job.keywords,
    ...params.job.requirements,
    ...params.job.preferred,
    ...(params.extra ?? []),
    ...params.episodes.flatMap((e) => [
      e.title,
      e.organization ?? "",
      e.role ?? "",
      ...e.skills,
      ...e.tags,
    ]),
    ...(params.facts ?? [])
      .filter((f) => f.status === "locked")
      .flatMap((f) => [f.label, f.value]),
  ];
  const terms = new Set<string>();
  for (const chunk of chunks) {
    const raw = chunk.trim();
    if (!raw) continue;
    terms.add(raw);
    for (const tok of latinTokensFrom(raw)) terms.add(tok);
  }
  return [...terms];
}

function allowedSet(allowedTerms?: string[]): Set<string> {
  const set = new Set<string>();
  for (const term of allowedTerms ?? []) {
    const t = term.trim().toLowerCase();
    if (t.length >= 2) set.add(t);
    for (const tok of latinTokensFrom(term)) {
      if (tok.length >= 2) set.add(tok.toLowerCase());
    }
  }
  return set;
}

function latinWordIssues(text: string, allowed?: Set<string>): string[] {
  const words = text.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) ?? [];
  const bad: string[] = [];
  for (const w of words) {
    if (ALLOWED_LATIN_TOKEN.test(w)) continue;
    if (allowed?.has(w.toLowerCase())) continue;
    bad.push(w);
  }
  return [...new Set(bad)].slice(0, 20);
}

export function findNonKoreanIssues(
  text: string,
  allowedTerms?: string[],
): string[] {
  FOREIGN_SCRIPT_RE.lastIndex = 0;
  const scripts = [...new Set(text.match(FOREIGN_SCRIPT_RE) ?? [])];
  const latin = latinWordIssues(text, allowedSet(allowedTerms));
  return [...scripts, ...latin];
}

export function hasNonKoreanScript(
  text: string,
  allowedTerms?: string[],
): boolean {
  return findNonKoreanIssues(text, allowedTerms).length > 0;
}

/**
 * 한글 외 문자 검출 시 재작성 최대 1회.
 * trusted English token만 있으면 LLM 호출 없음.
 */
export async function enforceKoreanOnly(params: {
  body: string;
  company: string;
  role: string;
  questionTitle: string;
  allowedTerms?: string[];
}): Promise<{ body: string; rewritten: boolean; remainingIssues: string[] }> {
  const text = params.body.trim();
  const issues = findNonKoreanIssues(text, params.allowedTerms);
  if (!issues.length) {
    return { body: text, rewritten: false, remainingIssues: [] };
  }

  const fixed = await llmText({
    route: "quality",
    system: `당신은 한국어 교정기입니다.
${KOREAN_ONLY_RULE}
의미·수치·사실·회사명·도구명(SQL, SPSS, Figma 등)은 유지한다.
외국어·한자·가나·베트남어가 섞인 부분만 한국어로 바꾼다.
본문만 출력하세요. 설명 금지.`,
    user: [
      `회사명(정확히 유지): ${params.company}`,
      `포지션(정확히 유지): ${params.role}`,
      `문항: ${params.questionTitle}`,
      `허용 고유명사: ${(params.allowedTerms ?? []).slice(0, 40).join(", ") || "(없음)"}`,
      `검출된 문제 표기: ${issues.join(" · ")}`,
      "",
      "아래 글을 한국어만 사용하도록 교정하세요. 허용 고유명사는 그대로 두세요:",
      text,
    ].join("\n"),
    maxTokens: 3500,
  });

  const next = fixed.trim() || text;
  return {
    body: next,
    rewritten: true,
    remainingIssues: findNonKoreanIssues(next, params.allowedTerms),
  };
}
