import OpenAI from "openai";
import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/** 환경변수 우선, 없으면 최신 → 안정 순으로 폴백 */
const GEMINI_MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
].filter((m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i);

let resolvedGeminiModel: string | null = null;

let openai: OpenAI | null = null;
let gemini: GoogleGenerativeAI | null = null;

/** OpenAI 결제/쿼터 이슈 시 이후 GPT 호출 스킵 */
let openaiBillingExhausted = false;
/** Gemini 429/쿼터 초과 시 이후 Gemini 호출 스킵 (한도 추가 소모 방지) */
let geminiQuotaExhausted = false;

export function llmStatus() {
  return {
    openaiConfigured:
      Boolean(process.env.OPENAI_API_KEY) && !openaiBillingExhausted,
    geminiConfigured:
      Boolean(process.env.GEMINI_API_KEY) && !geminiQuotaExhausted,
    /** @deprecated Claude 제거 — 하위 호환용 */
    claudeConfigured: false,
    primary: openaiBillingExhausted
      ? ("gemini" as const)
      : process.env.OPENAI_API_KEY
        ? ("openai" as const)
        : ("gemini" as const),
    fallback: "gemini" as const,
  };
}

export { SchemaType };
export type { ResponseSchema };

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

function assertAnyProvider() {
  if (getOpenAI() || getGemini()) return;

  if (openaiBillingExhausted && geminiQuotaExhausted) {
    throw new Error(
      "OpenAI 결제 잔액이 부족하고 Gemini 요청 한도도 초과되었습니다. platform.openai.com 에서 OpenAI 크레딧을 충전한 뒤 다시 시도해 주세요.",
    );
  }
  if (openaiBillingExhausted) {
    throw new Error(
      "OpenAI 결제 잔액/크레딧이 부족합니다. API 키만으로는 호출되지 않습니다. platform.openai.com/settings/organization/billing 에서 충전하세요.",
    );
  }
  if (geminiQuotaExhausted) {
    throw new Error(
      "Gemini API 요청 한도(429)를 초과했습니다. 잠시 후 다시 시도하거나 OpenAI 크레딧을 충전하세요.",
    );
  }
  throw new Error(
    "OPENAI_API_KEY 또는 GEMINI_API_KEY 중 하나 이상이 필요합니다.",
  );
}

function markOpenAIBillingIfNeeded(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // rate_limit 은 일시적이므로 영구 스킵하지 않음
  if (/insufficient_quota|billing_not_active|credit|payment|exceeded your current quota/i.test(msg)) {
    openaiBillingExhausted = true;
    console.warn(
      "[llm] OpenAI billing/quota exhausted — skipping OpenAI for this process",
    );
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
    console.warn(
      "[llm] Gemini quota/rate limited — skipping Gemini for this process",
    );
  }
}

/** LLM 응답에서 첫 번째 완전한 JSON 값만 추출 */
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

async function withProviderFallback<T>(
  label: string,
  runOpenAI: () => Promise<T>,
  runGemini: () => Promise<T>,
): Promise<T> {
  assertAnyProvider();
  const hasOpenAI = Boolean(getOpenAI());
  const hasGemini = Boolean(getGemini());

  if (hasOpenAI) {
    try {
      return await runOpenAI();
    } catch (err) {
      markOpenAIBillingIfNeeded(err);
      if (hasGemini) {
        console.warn(`[llm] OpenAI ${label} failed → Gemini fallback:`, err);
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

function formatProviderError(openaiErr?: unknown, geminiErr?: unknown): string {
  const parts: string[] = [];
  const openaiMsg = openaiErr instanceof Error ? openaiErr.message : "";
  const geminiMsg = geminiErr instanceof Error ? geminiErr.message : "";

  if (/insufficient_quota|billing|credit|payment|exceeded your current quota/i.test(openaiMsg)) {
    parts.push(
      "OpenAI 크레딧/결제 잔액이 부족합니다. API 키만으로는 부족하니 platform.openai.com 결제(Billing)에서 충전하세요.",
    );
  } else if (/incorrect api key|invalid_api_key|401/i.test(openaiMsg)) {
    parts.push("OpenAI API 키가 유효하지 않습니다.");
  } else if (openaiMsg) {
    parts.push(`OpenAI: ${openaiMsg.slice(0, 180)}`);
  }

  if (/API_KEY|api key|403|401|invalid.*key/i.test(geminiMsg)) {
    parts.push("Gemini API 키가 유효하지 않습니다.");
  } else if (/429|Too Many Requests|RESOURCE_EXHAUSTED|exceeded your/i.test(geminiMsg)) {
    parts.push(
      "Gemini 무료/요청 한도(429)를 초과했습니다. 잠시 기다리거나 OpenAI 크레딧을 충전하세요.",
    );
  } else if (/no longer available|not found|404|not supported/i.test(geminiMsg)) {
    parts.push(
      `Gemini 모델을 사용할 수 없습니다 (시도: ${GEMINI_MODEL_CANDIDATES.join(", ")}).`,
    );
  } else if (geminiMsg) {
    parts.push(`Gemini: ${geminiMsg.slice(0, 180)}`);
  }

  return parts.join(" / ") || "LLM 호출에 실패했습니다.";
}

async function runOpenAIText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  const client = getOpenAI();
  if (!client) throw new Error("OPENAI_API_KEY 없음");
  try {
    const res = await client.chat.completions.create({
      model: OPENAI_MODEL,
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
    markOpenAIBillingIfNeeded(err);
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

  const models = resolvedGeminiModel
    ? [
        resolvedGeminiModel,
        ...GEMINI_MODEL_CANDIDATES.filter((m) => m !== resolvedGeminiModel),
      ]
    : GEMINI_MODEL_CANDIDATES;

  let lastErr: unknown;
  for (const modelName of models) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
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
      resolvedGeminiModel = modelName;
      return result.response.text() ?? "";
    } catch (err) {
      lastErr = err;
      if (isGeminiQuotaError(err)) {
        markGeminiQuotaIfNeeded(err);
        throw new Error(
          "Gemini API 요청 한도(429)를 초과했습니다. 잠시 후 다시 시도하거나 OpenAI 크레딧을 충전하세요.",
        );
      }
      if (isGeminiModelMissingError(err)) {
        console.warn(`[llm] Gemini model unavailable: ${modelName}`, err);
        if (resolvedGeminiModel === modelName) resolvedGeminiModel = null;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("사용 가능한 Gemini 모델이 없습니다.");
}

export async function llmText(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  return withProviderFallback(
    "text",
    () => runOpenAIText(params),
    () => runGeminiText(params),
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
      : runOpenAIText({
          system,
          user,
          maxTokens: maxTokens ?? 4096,
          jsonMode: true,
        });

  const tryGeminiFirst =
    preferGemini || openaiBillingExhausted || !getOpenAI();

  if (tryGeminiFirst && getGemini()) {
    try {
      return await run(true);
    } catch {
      if (getOpenAI()) return run(false);
      throw new Error("JSON 복구 실패");
    }
  }
  if (getOpenAI()) {
    try {
      return await run(false);
    } catch (err) {
      markOpenAIBillingIfNeeded(err);
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
    : await runOpenAIText({
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
      params.useGemini || openaiBillingExhausted,
      params.responseSchema,
    );
    return parseLlmJson<T>(repaired);
  }
}

export async function llmJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  /** Gemini structured output schema (권장) */
  responseSchema?: ResponseSchema;
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
  );
}

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

async function runOpenAIVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getOpenAI();
  if (!client) throw new Error("OPENAI_API_KEY 없음");
  try {
    const res = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: params.maxTokens ?? 4096,
      messages: [
        { role: "system", content: params.system },
        {
          role: "user",
          content: [
            { type: "text", text: params.user },
            {
              type: "image_url",
              image_url: {
                url: `data:${params.mediaType};base64,${params.base64}`,
              },
            },
          ],
        },
      ],
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    markOpenAIBillingIfNeeded(err);
    throw err;
  }
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

  const models = resolvedGeminiModel
    ? [
        resolvedGeminiModel,
        ...GEMINI_MODEL_CANDIDATES.filter((m) => m !== resolvedGeminiModel),
      ]
    : GEMINI_MODEL_CANDIDATES;

  let lastErr: unknown;
  for (const modelName of models) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
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
      resolvedGeminiModel = modelName;
      return result.response.text() ?? "";
    } catch (err) {
      lastErr = err;
      if (isGeminiQuotaError(err)) {
        markGeminiQuotaIfNeeded(err);
        throw new Error(
          "Gemini API 요청 한도(429)를 초과했습니다. 잠시 후 다시 시도하거나 OpenAI 크레딧을 충전하세요.",
        );
      }
      if (isGeminiModelMissingError(err)) {
        console.warn(`[llm] Gemini vision model unavailable: ${modelName}`, err);
        if (resolvedGeminiModel === modelName) resolvedGeminiModel = null;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("사용 가능한 Gemini 모델이 없습니다.");
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
    () => runOpenAIVision(params),
    () => runGeminiVision(params),
  );
}
