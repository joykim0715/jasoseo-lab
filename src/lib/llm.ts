import Anthropic from "@anthropic-ai/sdk";
import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

/** 환경변수 우선, 없으면 최신 → 안정 순으로 폴백 */
const GEMINI_MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
].filter((m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i);

let resolvedGeminiModel: string | null = null;

let anthropic: Anthropic | null = null;
let gemini: GoogleGenerativeAI | null = null;

/** 크레딧 부족이 확인되면 이후 Claude 호출을 건너뜀 (서버 프로세스 단위) */
let claudeBillingExhausted = false;

export function llmStatus() {
  return {
    claudeConfigured: Boolean(process.env.ANTHROPIC_API_KEY) && !claudeBillingExhausted,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    primary: claudeBillingExhausted ? ("gemini" as const) : ("claude" as const),
    fallback: "gemini" as const,
  };
}

export { SchemaType };
export type { ResponseSchema };

function getAnthropic() {
  if (claudeBillingExhausted) return null;
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
  if (!getAnthropic() && !getGemini()) {
    if (claudeBillingExhausted && !process.env.GEMINI_API_KEY) {
      throw new Error(
        "Claude 크레딧이 부족하고 GEMINI_API_KEY도 없습니다. Anthropic 결제 충전 또는 Gemini 키를 설정해 주세요.",
      );
    }
    throw new Error(
      "ANTHROPIC_API_KEY 또는 GEMINI_API_KEY 중 하나 이상이 필요합니다.",
    );
  }
}

function markClaudeBillingIfNeeded(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/credit balance is too low|billing|quota|insufficient/i.test(msg)) {
    claudeBillingExhausted = true;
    console.warn("[llm] Claude billing exhausted — skipping Claude for this process");
  }
}

function isFallbackWorthy(_err: unknown): boolean {
  return true;
}

/** LLM 응답에서 첫 번째 완전한 JSON 값만 추출 (뒤에 설명/두번째 JSON이 붙어 있어도 무시) */
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

  // 잘린 경우: 시작부터 끝까지 (이후 salvage/closeOpenStructures가 보완)
  return cleaned.slice(start);
}

/** 흔한 JSON 깨짐을 로컬에서 복구 시도 */
function salvageJsonPayload(raw: string): string[] {
  const base = extractJsonPayload(raw);
  const variants = new Set<string>([base]);

  // 스마트 따옴표 → 일반 따옴표
  variants.add(
    base.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
  );

  // trailing commas
  for (const v of [...variants]) {
    variants.add(v.replace(/,\s*([}\]])/g, "$1"));
  }

  // 잘린 JSON: 열린 괄호 닫기
  for (const v of [...variants]) {
    variants.add(closeOpenStructures(v));
  }

  return [...variants];
}

function closeOpenStructures(input: string): string {
  let s = input.trimEnd();
  // 미완성 문자열이면 닫기
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

  // 값 도중 잘린 키/콜론 뒤 잔여 제거는 보수적으로 스킵
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
  throw new Error(
    `LLM JSON 파싱 실패: ${lastErr?.message ?? "unknown"}`,
  );
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
      markClaudeBillingIfNeeded(err);
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

  if (/credit balance is too low|billing|quota|insufficient/i.test(claudeMsg)) {
    parts.push(
      "Claude 크레딧/결제 잔액이 부족합니다. console.anthropic.com 에서 충전하거나 GEMINI만으로 계속 사용할 수 있습니다.",
    );
  } else if (claudeMsg) {
    parts.push(`Claude: ${claudeMsg.slice(0, 180)}`);
  }

  if (/API_KEY|api key|403|401|invalid.*key/i.test(geminiMsg)) {
    parts.push("Gemini API 키가 유효하지 않습니다.");
  } else if (/no longer available|not found|404|not supported/i.test(geminiMsg)) {
    parts.push(
      `Gemini 모델을 사용할 수 없습니다 (시도: ${GEMINI_MODEL_CANDIDATES.join(", ")}).`,
    );
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
  try {
    const res = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: params.maxTokens ?? 4096,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
    });
    const block = res.content.find((c) => c.type === "text");
    return block && block.type === "text" ? block.text : "";
  } catch (err) {
    markClaudeBillingIfNeeded(err);
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
    () => runClaudeText(params),
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
      : runClaudeText({ system, user, maxTokens: maxTokens ?? 4096 });

  const tryGeminiFirst = preferGemini || claudeBillingExhausted || !getAnthropic();

  if (tryGeminiFirst && getGemini()) {
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
    } catch (err) {
      markClaudeBillingIfNeeded(err);
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
      params.useGemini || claudeBillingExhausted,
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

async function runClaudeVision(params: {
  system: string;
  user: string;
  mediaType: MediaType;
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getAnthropic();
  if (!client) throw new Error("ANTHROPIC_API_KEY 없음");
  try {
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
  } catch (err) {
    markClaudeBillingIfNeeded(err);
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
    () => runClaudeVision(params),
    () => runGeminiVision(params),
  );
}
