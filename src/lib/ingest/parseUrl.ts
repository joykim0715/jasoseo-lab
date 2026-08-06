import * as cheerio from "cheerio";
import { assertSafePublicUrl } from "./ssrf";
import { structureJobPosting } from "./structureJd";
import type { JobPosting } from "../types";

function extractMainText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, header, iframe").remove();
  const candidates = [
    $("main").text(),
    $("article").text(),
    $("[class*='job'], [class*='recruit'], [id*='job'], [id*='recruit']").text(),
    $("body").text(),
  ];
  const best = candidates
    .map((t) => t.replace(/\s+/g, " ").trim())
    .sort((a, b) => b.length - a.length)[0];
  return best || "";
}

export async function ingestFromUrl(urlString: string): Promise<JobPosting> {
  const url = assertSafePublicUrl(urlString);
  const warnings: string[] = [];

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; JasoseoBot/1.0; +personal-cover-letter-tool)",
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
