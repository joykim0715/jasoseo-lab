import OpenAI from "openai";
import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import {
  UserLlmBusyError,
  UnusableLlmOutputError,
  assertUsableEssayBody,
  buildRouteChain,
  classifyLlmError,
  essayBodyChars,
  isPastAbort,
  isProviderSkipped,
  LLM_CALL_TIMEOUT_MS,
  llmBusyTelemetry,
  runProviderChain,
  shouldSkipSlowQuality,
  timingLog,
  withCallTimeout,
} from "./llmResilience";

/** 무료 메인: Groq (OpenAI 호환 API) */
export const GROQ_MODEL =
  process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
/** 유료 옵션(선택): OpenAI */
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
/** 한국어 문장: Gemini. GEMINI_MODEL env가 있으면 1순위로 존중 */
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

export { USER_LLM_BUSY, GEMINI_FALLBACK_MODEL } from "./llmResilience";

let lastLlmCall: { provider: "groq" | "openai" | "gemini"; model: string } | null =
  null;

export function getLastLlmCall() {
  return lastLlmCall;
}

let groq: OpenAI | null = null;
let openai: OpenAI | null = null;
let gemini: GoogleGenerativeAI | null = null;

let openaiBillingExhausted = false;

export function llmStatus() {
  const primary = getPrimaryChat()?.name ?? (getGemini() ? "gemini" : "none");
  return {
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    openaiConfigured:
      Boolean(process.env.OPENAI_API_KEY) && !openaiBillingExhausted,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    claudeConfigured: false,
    primary,
    fallback: "gemini" as const,
  };
}

export { SchemaType };
export type { ResponseSchema };

type ChatProvider = "groq" | "openai";

function getGroq() {
  if (!process.env.GROQ_API_KEY) return null;
  if (!groq) {
    groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return groq;
}

function getOpenAI() {
  if (openaiBillingExhausted) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return openai;
}

function getGemini() {
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
  throw new Error(
    "GROQ_API_KEY 또는 GEMINI_API_KEY 중 하나 이상이 필요합니다. (권장: 둘 다 — 무료)",
  );
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

async function executeRoute<T>(
  route: LlmRoute,
  runChat: () => Promise<T>,
  runGemini: (model: string) => Promise<T>,
  meta: { inputChars: number; maxTokens?: number; stage?: string },
): Promise<T> {
  assertAnyProvider();
  if (isPastAbort()) throw new UserLlmBusyError({ kind: "timeout" });
  const primary = getPrimaryChat();
  const includeChat =
    Boolean(primary) &&
    !(primary?.name === "groq" && isProviderSkipped("groq")) &&
    !(primary?.name === "openai" && isProviderSkipped("openai"));
  const includeGemini =
    Boolean(getGemini()) &&
    !isProviderSkipped("gemini") &&
    !shouldSkipSlowQuality();
  const steps = buildRouteChain({
    route,
    groqModel: includeChat ? primary?.model : undefined,
    chatProvider: primary?.name,
    geminiPrimary: GEMINI_MODEL,
    includeGroq: includeChat,
    includeGemini,
  });
  if (!steps.length) throw new UserLlmBusyError();

  try {
    return await runProviderChain({
      steps,
      stage: meta.stage,
      inputChars: meta.inputChars,
      maxTokens: meta.maxTokens,
      run: (step) =>
        step.provider === "gemini" ? runGemini(step.model) : runChat(),
    });
  } catch (err) {
    console.warn("[llm] all providers failed", {
      route,
      stage: meta.stage,
      ...llmBusyTelemetry(err),
      inputChars: meta.inputChars,
      maxTokens: meta.maxTokens,
    });
    if (err instanceof UserLlmBusyError) throw err;
    const classified = classifyLlmError(err);
    throw new UserLlmBusyError({
      kind: classified.kind,
      status: classified.status,
    });
  }
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
    const res = await withCallTimeout(
      primary.client.chat.completions.create(
        {
          model: primary.model,
          max_tokens: params.maxTokens ?? 4096,
          ...(params.jsonMode
            ? { response_format: { type: "json_object" as const } }
            : {}),
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        },
        { timeout: LLM_CALL_TIMEOUT_MS, maxRetries: 0 },
      ),
    );
    return res.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (primary.name === "openai") markOpenAIBillingIfNeeded(err);
    throw err;
  }
}

async function runGeminiText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
  responseSchema?: ResponseSchema;
  model?: string;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");
  const modelName = params.model ?? GEMINI_MODEL;

  lastLlmCall = { provider: "gemini", model: modelName };
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
  const result = await withCallTimeout(model.generateContent(params.user));
  return result.response.text() ?? "";
}

export async function llmText(params: {
  system: string;
  user: string;
  maxTokens?: number;
  stage?: string;
  /** quality면 Gemini 우선(한국어 문장), 기본 fast는 Groq 우선 */
  route?: LlmRoute;
}): Promise<string> {
  return executeRoute(
    params.route ?? "fast",
    () => runPrimaryText(params),
    (model) => runGeminiText({ ...params, model }),
    {
      stage: params.stage,
      inputChars: params.system.length + params.user.length,
      maxTokens: params.maxTokens ?? 4096,
    },
  );
}

async function repairJsonText(
  broken: string,
  maxTokens?: number,
  preferGemini?: boolean,
  responseSchema?: ResponseSchema,
  geminiModel?: string,
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
          model: geminiModel,
        })
      : runPrimaryText({
          system,
          user,
          maxTokens: maxTokens ?? 4096,
          jsonMode: true,
        });

  const tryGeminiFirst =
    (preferGemini || !getPrimaryChat()) &&
    Boolean(getGemini()) &&
    !shouldSkipSlowQuality();

  if (tryGeminiFirst) {
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
      if (getGemini() && !shouldSkipSlowQuality()) return run(true);
      throw new Error("JSON 복구 실패");
    }
  }
  return run(true);
}

function finishJson<T>(
  text: string,
  parsed: T,
  params: { requireBody?: boolean; stage?: string },
): T {
  if (params.requireBody) {
    const last = getLastLlmCall();
    timingLog("output", {
      contentChars: text.length,
      parsedBodyChars: essayBodyChars(parsed),
      provider: last?.provider,
      model: last?.model,
      stage: params.stage,
    });
    assertUsableEssayBody(parsed);
  }
  return parsed;
}

async function completeJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  useGemini: boolean;
  geminiModel?: string;
  responseSchema?: ResponseSchema;
  requireBody?: boolean;
  stage?: string;
}): Promise<T> {
  const system = `${params.system}\n\nRespond with valid JSON only. No markdown fences.`;
  const text = params.useGemini
    ? await runGeminiText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
        jsonMode: true,
        responseSchema: params.responseSchema,
        model: params.geminiModel,
      })
    : await runPrimaryText({
        system,
        user: params.user,
        maxTokens: params.maxTokens,
        jsonMode: true,
      });

  try {
    return finishJson(text, parseLlmJson<T>(text), params);
  } catch (parseErr) {
    if (parseErr instanceof UserLlmBusyError) throw parseErr;
    if (parseErr instanceof UnusableLlmOutputError) throw parseErr;
    console.warn("[llm] JSON parse failed, attempting repair:", parseErr);
    const repaired = await repairJsonText(
      text,
      params.maxTokens,
      params.useGemini || !getPrimaryChat(),
      params.responseSchema,
      params.geminiModel,
    );
    return finishJson(repaired, parseLlmJson<T>(repaired), params);
  }
}

export async function llmJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  stage?: string;
  responseSchema?: ResponseSchema;
  requireBody?: boolean;
  /** quality면 Gemini 우선(한국어 문장), 기본 fast는 Groq 우선 */
  route?: LlmRoute;
}): Promise<T> {
  return executeRoute(
    params.route ?? "fast",
    () =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: false,
        responseSchema: params.responseSchema,
        requireBody: params.requireBody,
        stage: params.stage,
      }),
    (model) =>
      completeJson<T>({
        system: params.system,
        user: params.user,
        maxTokens: params.maxTokens,
        useGemini: true,
        geminiModel: model,
        responseSchema: params.responseSchema,
        requireBody: params.requireBody,
        stage: params.stage,
      }),
    {
      stage: params.stage,
      inputChars: params.system.length + params.user.length,
      maxTokens: params.maxTokens ?? 4096,
    },
  );
}

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

async function runGeminiVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
  model: string;
}): Promise<string> {
  const client = getGemini();
  if (!client) throw new Error("GEMINI_API_KEY 없음");

  lastLlmCall = { provider: "gemini", model: params.model };
  const model = client.getGenerativeModel({
    model: params.model,
    systemInstruction: params.system,
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? 4096,
    },
  });
  const result = await withCallTimeout(
    model.generateContent([
      {
        inlineData: {
          mimeType: params.mediaType,
          data: params.base64,
        },
      },
      { text: params.user },
    ]),
  );
  return result.response.text() ?? "";
}

/** 이미지 OCR은 Gemini 무료 Vision 우선 (Groq는 텍스트 위주) */
export async function llmVisionText(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  if (!getGemini()) {
    throw new Error(
      "이미지 분석에는 GEMINI_API_KEY가 필요합니다. (무료 AI Studio 키)",
    );
  }
  const steps = buildRouteChain({
    route: "quality",
    geminiPrimary: GEMINI_MODEL,
    includeGroq: false,
    includeGemini: !isProviderSkipped("gemini"),
  });
  if (!steps.length) throw new UserLlmBusyError();
  try {
    return await runProviderChain({
      steps,
      stage: "vision",
      inputChars: params.system.length + params.user.length,
      maxTokens: params.maxTokens ?? 4096,
      run: (step) =>
        runGeminiVision({
          ...params,
          model: step.model,
        }),
    });
  } catch (err) {
    if (err instanceof UserLlmBusyError) throw err;
    throw new UserLlmBusyError();
  }
}
