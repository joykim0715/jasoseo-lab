import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

let anthropic: Anthropic | null = null;
let gemini: GoogleGenerativeAI | null = null;

export function llmStatus() {
  return {
    claudeConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    primary: "claude" as const,
    fallback: "gemini" as const,
  };
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function getGemini() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!gemini) {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

function assertAnyProvider() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY 또는 GEMINI_API_KEY 중 하나 이상이 필요합니다.",
    );
  }
}

function isFallbackWorthy(_err: unknown): boolean {
  // Provider/API 오류뿐 아니라 JSON 파싱 실패도 다른 모델로 재시도
  return true;
}

/** LLM 응답에서 JSON 객체/배열 본문만 추출 */
function extractJsonPayload(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);

  if (start === -1) return cleaned;

  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(close);
  if (end > start) return cleaned.slice(start, end + 1);
  return cleaned.slice(start);
}

function parseLlmJson<T>(text: string): T {
  const payload = extractJsonPayload(text);
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    throw new Error(`LLM JSON 파싱 실패: ${detail}`);
  }
}

async function withProviderFallback<T>(
  label: string,
  runClaude: () => Promise<T>,
  runGemini: () => Promise<T>,
): Promise<T> {
  assertAnyProvider();
  const hasClaude = Boolean(getAnthropic());
  const hasGemini = Boolean(getGemini());

  if (hasClaude) {
    try {
      return await runClaude();
    } catch (err) {
      if (hasGemini && isFallbackWorthy(err)) {
        console.warn(`[llm] Claude ${label} failed → Gemini fallback:`, err);
        try {
          return await runGemini();
        } catch (geminiErr) {
          throw new Error(formatProviderError(err, geminiErr));
        }
      }
      throw new Error(formatProviderError(err));
    }
  }

  try {
    return await runGemini();
  } catch (geminiErr) {
    throw new Error(formatProviderError(undefined, geminiErr));
  }
}

function formatProviderError(claudeErr?: unknown, geminiErr?: unknown): string {
  const parts: string[] = [];
  const claudeMsg = claudeErr instanceof Error ? claudeErr.message : "";
  const geminiMsg = geminiErr instanceof Error ? geminiErr.message : "";

  if (/credit balance is too low|billing|quota/i.test(claudeMsg)) {
    parts.push("Claude 크레딧/결제 잔액이 부족합니다.");
  } else if (claudeMsg) {
    parts.push(`Claude: ${claudeMsg.slice(0, 180)}`);
  }

  if (/no longer available|not found|404/i.test(geminiMsg)) {
    parts.push("Gemini 모델명을 확인해 주세요 (기본: gemini-3.5-flash).");
  } else if (/API_KEY|api key|403|401/i.test(geminiMsg)) {
    parts.push("Gemini API 키가 유효하지 않습니다.");
  } else if (geminiMsg) {
    parts.push(`Gemini: ${geminiMsg.slice(0, 180)}`);
  }

  return parts.join(" / ") || "LLM 호출에 실패했습니다.";
}

async function runClaudeText(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getAnthropic();
  if (!client) throw new Error("ANTHROPIC_API_KEY 없음");
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  });
  const block = res.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function runGeminiText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: params.system,
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? 4096,
      ...(params.jsonMode
        ? { responseMimeType: "application/json" as const }
        : {}),
    },
  });
  const result = await model.generateContent(params.user);
  return result.response.text() ?? "";
}

export async function llmText(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  return withProviderFallback(
    "text",
    () => runClaudeText(params),
    () => runGeminiText(params),
  );
}

async function repairJsonText(
  broken: string,
  maxTokens?: number,
  preferGemini?: boolean,
): Promise<string> {
  const system =
    "You repair malformed JSON. Output valid JSON only. No markdown fences, no commentary.";
  const user = `Fix this into valid JSON:\n\n${broken.slice(0, 12000)}`;
  const run = async (useGemini: boolean) =>
    useGemini
      ? runGeminiText({ system, user, maxTokens: maxTokens ?? 4096, jsonMode: true })
      : runClaudeText({ system, user, maxTokens: maxTokens ?? 4096 });

  if (preferGemini && getGemini()) {
    try {
      return await run(true);
    } catch {
      if (getAnthropic()) return run(false);
      throw new Error("JSON 복구 실패");
    }
  }
  if (getAnthropic()) {
    try {
      return await run(false);
    } catch {
      if (getGemini()) return run(true);
      throw new Error("JSON 복구 실패");
    }
  }
  return run(true);
}

async function completeJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  useGemini: boolean;
}): Promise<T> {
  const system = `${params.system}\n\nRespond with valid JSON only. No markdown fences.`;
  const text = params.useGemini
    ? await runGeminiText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
        jsonMode: true,
      })
    : await runClaudeText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
      });

  try {
    return parseLlmJson<T>(text);
  } catch (parseErr) {
    console.warn("[llm] JSON parse failed, attempting repair:", parseErr);
    const repaired = await repairJsonText(
      text,
      params.maxTokens,
      params.useGemini,
    );
    return parseLlmJson<T>(repaired);
  }
}

export async function llmJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  return withProviderFallback(
    "json",
    () =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: false,
      }),
    () =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: true,
      }),
  );
}

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

async function runClaudeVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getAnthropic();
  if (!client) throw new Error("ANTHROPIC_API_KEY 없음");
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: params.mediaType,
              data: params.base64,
            },
          },
          { type: "text", text: params.user },
        ],
      },
    ],
  });
  const block = res.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function runGeminiVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: params.system,
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? 4096,
    },
  });
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: params.mediaType,
        data: params.base64,
      },
    },
    { text: params.user },
  ]);
  return result.response.text() ?? "";
}

export async function llmVisionText(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  return withProviderFallback(
    "vision",
    () => runClaudeVision(params),
    () => runGeminiVision(params),
  );
}
