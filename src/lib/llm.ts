import OpenAI from "openai";
import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";

/** 무료 메인: Groq (OpenAI 호환 API) */
export const GROQ_MODEL =
  process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
/** 유료 옵션(선택): OpenAI */
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
/** 한국어 문장: Gemini. 구형 flash로 조용히 내려가지 않음 */
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

let lastLlmCall: { provider: "groq" | "openai" | "gemini"; model: string } | null =
  null;

export function getLastLlmCall() {
  return lastLlmCall;
}

let groq: OpenAI | null = null;
let openai: OpenAI | null = null;
let gemini: GoogleGenerativeAI | null = null;

let groqQuotaExhausted = false;
let openaiBillingExhausted = false;
let geminiQuotaExhausted = false;

export function llmStatus() {
  const primary = getPrimaryChat()?.name ?? (getGemini() ? "gemini" : "none");
  return {
    groqConfigured: Boolean(process.env.GROQ_API_KEY) && !groqQuotaExhausted,
    openaiConfigured:
      Boolean(process.env.OPENAI_API_KEY) && !openaiBillingExhausted,
    geminiConfigured:
      Boolean(process.env.GEMINI_API_KEY) && !geminiQuotaExhausted,
    claudeConfigured: false,
    primary,
    fallback: "gemini" as const,
  };
}

export { SchemaType };
export type { ResponseSchema };

type ChatProvider = "groq" | "openai";

function getGroq() {
  if (groqQuotaExhausted) return null;
  if (!process.env.GROQ_API_KEY) return null;
  if (!groq) {
    groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return groq;
}

function getOpenAI() {
  if (openaiBillingExhausted) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

function getGemini() {
  if (geminiQuotaExhausted) return null;
  if (!process.env.GEMINI_API_KEY) return null;
  if (!gemini) {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

/** 무료 Groq 우선 → (선택) OpenAI → Gemini 폴백 */
function getPrimaryChat(): {
  client: OpenAI;
  model: string;
  name: ChatProvider;
} | null {
  const g = getGroq();
  if (g) return { client: g, model: GROQ_MODEL, name: "groq" };
  const o = getOpenAI();
  if (o) return { client: o, model: OPENAI_MODEL, name: "openai" };
  return null;
}

function assertAnyProvider() {
  if (getPrimaryChat() || getGemini()) return;

  if (groqQuotaExhausted && geminiQuotaExhausted) {
    throw new Error(
      "Groq·Gemini 모두 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나 console.groq.com 에서 새 키/한도를 확인해 주세요.",
    );
  }
  if (geminiQuotaExhausted && !process.env.GROQ_API_KEY) {
    throw new Error(
      "Gemini 요청 한도(429) 초과. 무료로 쓰려면 Groq API 키(GROQ_API_KEY)를 추가하세요: console.groq.com",
    );
  }
  throw new Error(
    "GROQ_API_KEY 또는 GEMINI_API_KEY 중 하나 이상이 필요합니다. (권장: 둘 다 — 무료)",
  );
}

function markGroqQuotaIfNeeded(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate_limit|too many requests|quota/i.test(msg)) {
    groqQuotaExhausted = true;
    console.warn("[llm] Groq rate limited — skipping Groq for this process");
  }
}

function markOpenAIBillingIfNeeded(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /insufficient_quota|billing_not_active|credit|payment|exceeded your current quota/i.test(
      msg,
    )
  ) {
    openaiBillingExhausted = true;
    console.warn("[llm] OpenAI billing exhausted — skipping OpenAI");
  }
}

function isGeminiQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests|RESOURCE_EXHAUSTED|exceeded your|quota/i.test(
    msg,
  );
}

function markGeminiQuotaIfNeeded(err: unknown) {
  if (isGeminiQuotaError(err)) {
    geminiQuotaExhausted = true;
    console.warn("[llm] Gemini quota/rate limited — skipping Gemini");
  }
}

function extractJsonPayload(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\S]*$/i, "")
    .trim();

  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start === -1) return cleaned;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

function closeOpenStructures(input: string): string {
  let s = input.trimEnd();
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  const stack: string[] = [];
  inString = false;
  escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }
  return s.replace(/,\s*([}\]])/g, "$1");
}

function salvageJsonPayload(raw: string): string[] {
  const base = extractJsonPayload(raw);
  const variants = new Set<string>([base]);
  variants.add(
    base.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
  );
  for (const v of [...variants]) {
    variants.add(v.replace(/,\s*([}\]])/g, "$1"));
  }
  for (const v of [...variants]) {
    variants.add(closeOpenStructures(v));
  }
  return [...variants];
}

function parseLlmJson<T>(text: string): T {
  const attempts = salvageJsonPayload(text);
  let lastErr: Error | null = null;
  for (const payload of attempts) {
    try {
      return JSON.parse(payload) as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(`LLM JSON 파싱 실패: ${lastErr?.message ?? "unknown"}`);
}

export type LlmRoute = "fast" | "quality";

/**
 * fast: Groq/OpenAI → Gemini (구조화·추출용)
 * quality: Gemini → Groq/OpenAI (한국어 자소서 문장용)
 */
async function withProviderFallback<T>(
  label: string,
  runPrimary: () => Promise<T>,
  runGemini: () => Promise<T>,
  route: LlmRoute = "fast",
): Promise<T> {
  assertAnyProvider();
  const hasPrimary = Boolean(getPrimaryChat());
  const hasGemini = Boolean(getGemini());

  if (route === "quality" && hasGemini) {
    try {
      return await runGemini();
    } catch (geminiErr) {
      markGeminiQuotaIfNeeded(geminiErr);
      if (hasPrimary) {
        console.warn(`[llm] Gemini ${label} failed → Groq/OpenAI:`, geminiErr);
        try {
          return await runPrimary();
        } catch (primaryErr) {
          throw new Error(formatProviderError(primaryErr, geminiErr));
        }
      }
      throw new Error(formatProviderError(undefined, geminiErr));
    }
  }

  if (hasPrimary) {
    try {
      return await runPrimary();
    } catch (err) {
      if (hasGemini) {
        console.warn(`[llm] Primary ${label} failed → Gemini:`, err);
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

function formatProviderError(primaryErr?: unknown, geminiErr?: unknown): string {
  const parts: string[] = [];
  const primaryMsg = primaryErr instanceof Error ? primaryErr.message : "";
  const geminiMsg = geminiErr instanceof Error ? geminiErr.message : "";

  if (/429|rate_limit|too many requests/i.test(primaryMsg)) {
    parts.push("Groq/메인 LLM 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.");
  } else if (/insufficient_quota|billing|credit|payment/i.test(primaryMsg)) {
    parts.push(
      "유료 LLM 잔액이 부족합니다. 무료로 쓰려면 GROQ_API_KEY를 설정하세요.",
    );
  } else if (primaryMsg) {
    parts.push(`메인 LLM: ${primaryMsg.slice(0, 180)}`);
  }

  if (/429|Too Many Requests|RESOURCE_EXHAUSTED|exceeded your/i.test(geminiMsg)) {
    parts.push(
      "Gemini 무료 한도(429) 초과. 잠시 기다리거나 Groq 키를 추가하세요 (console.groq.com).",
    );
  } else if (/API_KEY|api key|401|403/i.test(geminiMsg)) {
    parts.push("Gemini API 키가 유효하지 않습니다.");
  } else if (geminiMsg) {
    parts.push(`Gemini: ${geminiMsg.slice(0, 180)}`);
  }

  return parts.join(" / ") || "LLM 호출에 실패했습니다.";
}

async function runPrimaryText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  const primary = getPrimaryChat();
  if (!primary) throw new Error("GROQ_API_KEY 또는 OPENAI_API_KEY 없음");
  try {
    lastLlmCall = { provider: primary.name, model: primary.model };
    const res = await primary.client.chat.completions.create({
      model: primary.model,
      max_tokens: params.maxTokens ?? 4096,
      ...(params.jsonMode
        ? { response_format: { type: "json_object" as const } }
        : {}),
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (primary.name === "groq") markGroqQuotaIfNeeded(err);
    else markOpenAIBillingIfNeeded(err);
    throw err;
  }
}

function isGeminiModelMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no longer available|not found|404|is not found|not supported for/i.test(
    msg,
  );
}

async function runGeminiText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
  responseSchema?: ResponseSchema;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");

  try {
    lastLlmCall = { provider: "gemini", model: GEMINI_MODEL };
    const model = client.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: params.system,
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 4096,
        ...(params.jsonMode || params.responseSchema
          ? {
              responseMimeType: "application/json" as const,
              ...(params.responseSchema
                ? { responseSchema: params.responseSchema }
                : {}),
            }
          : {}),
      },
    });
    const result = await model.generateContent(params.user);
    return result.response.text() ?? "";
  } catch (err) {
    if (isGeminiQuotaError(err)) {
      markGeminiQuotaIfNeeded(err);
      throw new Error(
        "Gemini API 요청 한도(429)를 초과했습니다. 잠시 후 다시 시도하거나 Groq API 키를 추가하세요.",
      );
    }
    if (isGeminiModelMissingError(err)) {
      console.warn(`[llm] Gemini model unavailable: ${GEMINI_MODEL}`, err);
    }
    throw err;
  }
}

export async function llmText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  /** quality면 Gemini 우선(한국어 문장), 기본 fast는 Groq 우선 */
  route?: LlmRoute;
}): Promise<string> {
  return withProviderFallback(
    "text",
    () => runPrimaryText(params),
    () => runGeminiText(params),
    params.route ?? "fast",
  );
}

async function repairJsonText(
  broken: string,
  maxTokens?: number,
  preferGemini?: boolean,
  responseSchema?: ResponseSchema,
): Promise<string> {
  const system =
    "You repair malformed JSON. Output valid JSON only. No markdown fences, no commentary.";
  const user = `Fix this into valid JSON:\n\n${broken.slice(0, 12000)}`;
  const run = async (useGemini: boolean) =>
    useGemini
      ? runGeminiText({
          system,
          user,
          maxTokens: maxTokens ?? 4096,
          jsonMode: true,
          responseSchema,
        })
      : runPrimaryText({
          system,
          user,
          maxTokens: maxTokens ?? 4096,
          jsonMode: true,
        });

  const tryGeminiFirst = preferGemini || !getPrimaryChat();

  if (tryGeminiFirst && getGemini()) {
    try {
      return await run(true);
    } catch {
      if (getPrimaryChat()) return run(false);
      throw new Error("JSON 복구 실패");
    }
  }
  if (getPrimaryChat()) {
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
  responseSchema?: ResponseSchema;
}): Promise<T> {
  const system = `${params.system}\n\nRespond with valid JSON only. No markdown fences.`;
  const text = params.useGemini
    ? await runGeminiText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
        jsonMode: true,
        responseSchema: params.responseSchema,
      })
    : await runPrimaryText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
        jsonMode: true,
      });

  try {
    return parseLlmJson<T>(text);
  } catch (parseErr) {
    console.warn("[llm] JSON parse failed, attempting repair:", parseErr);
    const repaired = await repairJsonText(
      text,
      params.maxTokens,
      params.useGemini || !getPrimaryChat(),
      params.responseSchema,
    );
    return parseLlmJson<T>(repaired);
  }
}

export async function llmJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  responseSchema?: ResponseSchema;
  /** quality면 Gemini 우선(한국어 문장), 기본 fast는 Groq 우선 */
  route?: LlmRoute;
}): Promise<T> {
  return withProviderFallback(
    "json",
    () =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: false,
        responseSchema: params.responseSchema,
      }),
    () =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: true,
        responseSchema: params.responseSchema,
      }),
    params.route ?? "fast",
  );
}

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

async function runGeminiVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");

  try {
    lastLlmCall = { provider: "gemini", model: GEMINI_MODEL };
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
  } catch (err) {
    if (isGeminiQuotaError(err)) {
      markGeminiQuotaIfNeeded(err);
      throw new Error(
        "Gemini API 요청 한도(429)를 초과했습니다. 잠시 후 다시 시도하세요.",
      );
    }
    if (isGeminiModelMissingError(err)) {
      console.warn(`[llm] Gemini vision model unavailable: ${GEMINI_MODEL}`, err);
    }
    throw err;
  }
}

/** 이미지 OCR은 Gemini 무료 Vision 우선 (Groq는 텍스트 위주) */
export async function llmVisionText(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  if (getGemini()) {
    try {
      return await runGeminiVision(params);
    } catch (err) {
      markGeminiQuotaIfNeeded(err);
      throw new Error(formatProviderError(undefined, err));
    }
  }
  throw new Error(
    "이미지 분석에는 GEMINI_API_KEY가 필요합니다. (무료 AI Studio 키)",
  );
}
