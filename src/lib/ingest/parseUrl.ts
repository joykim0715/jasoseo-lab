import * as cheerio from "cheerio";
import { assertSafePublicUrl } from "./ssrf";
import { structureJobPosting } from "./structureJd";
import type { JobPosting } from "../types";

function cleanText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function extractMainText(html: string): string {
  const $ = cheerio.load(html);

  // 제목은 header/nav에 있는 경우가 많아 제거 전에 확보
  const pageTitle = cleanText($("title").first().text());
  const ogTitle = cleanText(
    $('meta[property="og:title"]').attr("content") ||
      $('meta[name="og:title"]').attr("content") ||
      "",
  );
  const ogDescription = cleanText(
    $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      "",
  );
  const h1 = cleanText($("h1").first().text());

  $("script, style, noscript, nav, footer, iframe").remove();
  // header는 메뉴만 있는 경우가 많아 제거하되, h1은 위에서 이미 확보

  const candidates = [
    $("main").text(),
    $("article").text(),
    $("[class*='job'], [class*='recruit'], [class*='Job'], [id*='job'], [id*='recruit']").text(),
    $("body").text(),
  ];
  const body = candidates
    .map((t) => cleanText(t))
    .sort((a, b) => b.length - a.length)[0] || "";

  const metaLines = [
    pageTitle && `페이지 제목: ${pageTitle}`,
    ogTitle && ogTitle !== pageTitle && `OG 제목: ${ogTitle}`,
    h1 && `공고 제목(H1): ${h1}`,
    ogDescription && `요약: ${ogDescription}`,
  ].filter(Boolean);

  if (!metaLines.length) return body;
  return `${metaLines.join("\n")}\n\n${body}`;
}

export async function ingestFromUrl(urlString: string): Promise<JobPosting> {
  const url = assertSafePublicUrl(urlString);
  const warnings: string[] = [];

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      "URL을 가져오지 못했습니다. 텍스트를 붙여넣거나 스크린샷을 업로드해 주세요.",
    );
  }

  if (!res.ok) {
    throw new Error(
      `URL 응답 오류 (${res.status}). 로그인·차단 페이지일 수 있습니다. 텍스트/이미지로 다시 시도하세요.`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    warnings.push("HTML이 아닌 응답입니다. 본문 추출이 불완전할 수 있습니다.");
  }

  const html = await res.text();
  const text = extractMainText(html);

  if (text.length < 80) {
    warnings.push(
      "본문이 거의 추출되지 않았습니다. 로그인 벽·자바스크립트 렌더링일 수 있습니다. 텍스트 붙여넣기 또는 스크린샷을 권장합니다.",
    );
  }

  if (/로그인|sign in|log in|인증이 필요/i.test(text) && text.length < 400) {
    warnings.push("로그인 페이지로 보입니다. 공고 본문 텍스트를 직접 붙여넣어 주세요.");
  }

  return structureJobPosting(text || html.slice(0, 5000), warnings);
}
