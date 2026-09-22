import { AsyncLocalStorage } from "node:async_hooks";

export const USER_LLM_BUSY =
  "현재 무료 AI 모델의 요청 한도 또는 일시적 서버 혼잡으로 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.";

export const GEMINI_FALLBACK_MODEL = "gemini-3.7-flash";
export const MAX_ATTEMPTS_PER_MODEL = 2;
/** 5xx/timeout: 0.8~1.2초 구간의 고정값. 테스트 결정성을 위해 랜덤하지 않음. */
export const SERVER_RETRY_MS = 1000;
/** 이보다 긴 retry-after / token reset 은 기다리지 않고 fallback */
export const SHORT_RETRY_AFTER_MS = 3000;
/** 정상 quality draft(~10–20s)는 통과, hang/늦은 503은 자른다. */
export const LLM_CALL_TIMEOUT_MS = 25_000;
/** Gemini 연쇄를 접고 Groq로 완주 시도 */
export const REQUEST_SOFT_DEADLINE_MS = 240_000;
/** 새 LLM 호출 금지. in-flight + timeout = 285s, Vercel 300s까지 15s 여유 */
export const REQUEST_ABORT_MS = 260_000;
export const VERCEL_MAX_DURATION_MS = 300_000;

export type LlmProvider = "groq" | "openai" | "gemini";

export type LlmErrorKind =
  | "rate_limit"
  | "server"
  | "timeout"
  | "auth"
  | "invalid"
  | "other";

export type ClassifiedLlmError = {
  retryable: boolean;
  status?: number;
  kind: LlmErrorKind;
};

export type ChainStep = {
  provider: LlmProvider;
  model: string;
};

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "fallback"; reason: string };

type LlmRequestState = {
  skipped: Partial<Record<LlmProvider, LlmErrorKind>>;
  interactive: boolean;
  startedAt: number;
  softDeadlineMs: number;
  abortMs: number;
  question?: number;
};

export type LlmRequestOptions = {
  interactive?: boolean;
  startedAt?: number;
  softDeadlineMs?: number;
  abortMs?: number;
};

const llmRequest = new AsyncLocalStorage<LlmRequestState>();

export function runWithLlmRequest<T>(fn: () => T, opts?: LlmRequestOptions): T {
  const interactive = Boolean(opts?.interactive);
  return llmRequest.run(
    {
      skipped: {},
      interactive,
      startedAt: opts?.startedAt ?? Date.now(),
      softDeadlineMs: interactive
        ? (opts?.softDeadlineMs ?? REQUEST_SOFT_DEADLINE_MS)
        : Number.POSITIVE_INFINITY,
      abortMs: interactive
        ? (opts?.abortMs ?? REQUEST_ABORT_MS)
        : Number.POSITIVE_INFINITY,
    },
    fn,
  );
}

export function setTimingQuestion(n: number | undefined) {
  const store = llmRequest.getStore();
  if (store) store.question = n;
}

export function requestElapsedMs(): number {
  const store = llmRequest.getStore();
  return store ? Math.max(0, Date.now() - store.startedAt) : 0;
}

export function timingLog(
  event: string,
  extra: Record<string, string | number | undefined> = {},
) {
  const parts = [`[timing] ${event}`, `elapsedMs=${requestElapsedMs()}`];
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === "") continue;
    parts.push(`${k}=${v}`);
  }
  console.info(parts.join(" "));
}

export function sameModelRetryEnabled(): boolean {
  const store = llmRequest.getStore();
  if (!store) return true;
  return !store.interactive;
}

export function shouldSkipSlowQuality(): boolean {
  const store = llmRequest.getStore();
  if (!store?.interactive) return false;
  return Date.now() - store.startedAt >= store.softDeadlineMs;
}

export function isPastAbort(): boolean {
  const store = llmRequest.getStore();
  if (!store?.interactive) return false;
  return Date.now() - store.startedAt >= store.abortMs;
}

export function llmCallTimeoutError(ms = LLM_CALL_TIMEOUT_MS): Error {
  const err = new Error(`LLM_CALL_TIMEOUT ${ms}ms`);
  err.name = "AbortError";
  return err;
}

/** ponytail: race only; legacy Gemini SDK has no abort, in-flight may finish in background */
export async function withCallTimeout<T>(
  work: Promise<T>,
  ms = LLM_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(llmCallTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isProviderSkipped(provider: LlmProvider): boolean {
  return Boolean(llmRequest.getStore()?.skipped[provider]);
}

export function skippedProviders(): Partial<Record<LlmProvider, LlmErrorKind>> {
  return { ...(llmRequest.getStore()?.skipped ?? {}) };
}

export function markProviderSkipped(provider: LlmProvider, kind: LlmErrorKind) {
  const store = llmRequest.getStore();
  if (!store) return;
  store.skipped[provider] = kind;
}

export function filterAvailableSteps(steps: ChainStep[]): ChainStep[] {
  return steps.filter((s) => !isProviderSkipped(s.provider));
}

/** 429/auth 만 요청 범위에서 provider 를 뺀다. 5xx 는 다음 stage 에서 다시 시도. */
export function rememberExhaustedProvider(
  step: ChainStep,
  classified: ClassifiedLlmError,
  chain: ChainStep[],
) {
  if (classified.kind === "auth") {
    markProviderSkipped(step.provider, classified.kind);
    return;
  }
  if (classified.kind !== "rate_limit") return;
  if (step.provider === "gemini") {
    const last = [...chain].reverse().find((s) => s.provider === "gemini");
    if (last && last.model !== step.model) return;
  }
  markProviderSkipped(step.provider, classified.kind);
}

const RATE_LIMIT_HEADER_KEYS = [
  "retry-after",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

function asRecord(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") return err as Record<string, unknown>;
  return {};
}

function headerMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (typeof (raw as Headers).get === "function") {
    for (const key of RATE_LIMIT_HEADER_KEYS) {
      const v = (raw as Headers).get(key);
      if (v) out[key] = v;
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

export function extractHttpStatus(err: unknown): number | undefined {
  const rec = asRecord(err);
  const direct = rec.status ?? rec.statusCode ?? rec.httpStatus;
  if (typeof direct === "number" && direct >= 100 && direct <= 599) return direct;
  if (typeof direct === "string" && /^\d{3}$/.test(direct)) return Number(direct);
  const nested = rec.error;
  if (nested && typeof nested === "object") {
    const n =
      (nested as { code?: unknown; status?: unknown }).status ??
      (nested as { code?: unknown }).code;
    if (typeof n === "number" && n >= 100 && n <= 599) return n;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    msg.match(/\[(\d{3})\s/) ||
    msg.match(/\bstatus(?:Code)?[:\s]+(\d{3})\b/i) ||
    msg.match(/\b(429|500|502|503|504|400|401|403|404)\b/);
  if (m) return Number(m[1]);
  return undefined;
}

export function extractErrorHeaders(err: unknown): Record<string, string> {
  const rec = asRecord(err);
  const response = asRecord(rec.response);
  const nested = asRecord(rec.error);
  const merged: Record<string, string> = {
    ...headerMap(rec.headers ?? rec.header),
    ...headerMap(response.headers),
    ...headerMap(nested.headers),
  };
  return pickRateLimitHeaders(merged);
}

function isTimeoutError(err: unknown): boolean {
  const rec = asRecord(err);
  if (rec.name === "APIConnectionTimeoutError" || rec.name === "AbortError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ETIMEDOUT|ENETUNREACH|ECONNRESET|network|fetch failed|socket/i.test(
    msg,
  );
}

function isInvalidModel(err: unknown, status?: number): boolean {
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid model|no longer available|is not found|not found|does not exist|not supported for/i.test(
    msg,
  );
}

export function classifyLlmError(err: unknown): ClassifiedLlmError {
  const status = extractHttpStatus(err);
  if (status === 429) {
    return { retryable: true, status, kind: "rate_limit" };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return { retryable: true, status, kind: "server" };
  }
  if (status === 401 || status === 403) {
    return { retryable: false, status, kind: "auth" };
  }
  if (status === 400 || isInvalidModel(err, status)) {
    return { retryable: false, status, kind: "invalid" };
  }
  if (isTimeoutError(err)) {
    return { retryable: true, status, kind: "timeout" };
  }
  return { retryable: false, status, kind: "other" };
}

export function pickRateLimitHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of RATE_LIMIT_HEADER_KEYS) {
    const v = headers[key] ?? headers[key.replace(/-/g, "_")];
    if (v) out[key] = v;
  }
  return out;
}

export function parseDurationMs(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const t = raw.trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (n > 1e12) return Math.max(0, Math.round(n - Date.now()));
    if (n > 1e9) return Math.max(0, Math.round(n * 1000 - Date.now()));
    return Math.round(n * 1000);
  }
  const asDate = Date.parse(t);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());

  let ms = 0;
  let matched = false;
  const re = /([\d.]+)\s*(ms|s|m|h)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    matched = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u === "ms") ms += n;
    else if (u === "s") ms += n * 1000;
    else if (u === "m") ms += n * 60_000;
    else if (u === "h") ms += n * 3_600_000;
  }
  return matched ? Math.round(ms) : undefined;
}

export function inferRateLimitKind(
  headers: Record<string, string>,
): "rpm" | "tpm" | "unknown" {
  const req = headers["x-ratelimit-remaining-requests"];
  const tok = headers["x-ratelimit-remaining-tokens"];
  const reqN = req != null && req !== "" ? Number(req) : undefined;
  const tokN = tok != null && tok !== "" ? Number(tok) : undefined;
  if (tokN === 0 && reqN !== 0) return "tpm";
  if (reqN === 0 && tokN !== 0) return "rpm";
  if (reqN === 0 && tokN === 0) {
    const rt = parseDurationMs(headers["x-ratelimit-reset-tokens"]);
    const rr = parseDurationMs(headers["x-ratelimit-reset-requests"]);
    if (rt != null && rr != null) return rt >= rr ? "tpm" : "rpm";
    return "rpm";
  }
  return "unknown";
}

export function decideRetry(
  err: unknown,
  attempt: number,
  sameModelRetry = true,
): RetryDecision {
  const classified = classifyLlmError(err);
  if (!classified.retryable) {
    return { action: "fallback", reason: classified.kind };
  }
  if (!sameModelRetry) {
    return { action: "fallback", reason: classified.kind };
  }
  if (attempt >= MAX_ATTEMPTS_PER_MODEL) {
    return { action: "fallback", reason: "attempts_exhausted" };
  }

  if (classified.kind === "rate_limit") {
    const headers = extractErrorHeaders(err);
    const retryAfterMs = parseDurationMs(headers["retry-after"]);
    const tokenResetMs = parseDurationMs(headers["x-ratelimit-reset-tokens"]);
    const reqResetMs = parseDurationMs(headers["x-ratelimit-reset-requests"]);
    const tokRaw = headers["x-ratelimit-remaining-tokens"];
    const reqRaw = headers["x-ratelimit-remaining-requests"];
    const tokN = tokRaw != null && tokRaw !== "" ? Number(tokRaw) : undefined;
    const reqN = reqRaw != null && reqRaw !== "" ? Number(reqRaw) : undefined;

    if (tokN === 0 && tokenResetMs != null && tokenResetMs > SHORT_RETRY_AFTER_MS) {
      return { action: "fallback", reason: "token_reset_too_long" };
    }
    if (retryAfterMs != null && retryAfterMs > SHORT_RETRY_AFTER_MS) {
      return { action: "fallback", reason: "retry_after_too_long" };
    }
    if (retryAfterMs != null) {
      return { action: "retry", delayMs: retryAfterMs };
    }
    if (reqN === 0 && reqResetMs != null && reqResetMs <= SHORT_RETRY_AFTER_MS) {
      return { action: "retry", delayMs: reqResetMs };
    }
    if (tokN === 0 && tokenResetMs != null && tokenResetMs <= SHORT_RETRY_AFTER_MS) {
      return { action: "retry", delayMs: tokenResetMs };
    }
    return { action: "fallback", reason: "rate_limit_no_short_retry" };
  }

  return { action: "retry", delayMs: SERVER_RETRY_MS };
}

export function geminiModelChain(primary: string): string[] {
  const first = primary.trim() || "gemini-3.8-flash";
  const chain = [first];
  if (first !== GEMINI_FALLBACK_MODEL) chain.push(GEMINI_FALLBACK_MODEL);
  return chain;
}

export function buildRouteChain(params: {
  route: "fast" | "quality";
  groqModel?: string;
  chatProvider?: "groq" | "openai";
  geminiPrimary: string;
  includeGroq: boolean;
  includeGemini: boolean;
}): ChainStep[] {
  const groq: ChainStep[] =
    params.includeGroq && params.groqModel
      ? [
          {
            provider: params.chatProvider ?? "groq",
            model: params.groqModel,
          },
        ]
      : [];
  const gemini: ChainStep[] = params.includeGemini
    ? geminiModelChain(params.geminiPrimary).map((model) => ({
        provider: "gemini" as const,
        model,
      }))
    : [];
  return params.route === "quality" ? [...gemini, ...groq] : [...groq, ...gemini];
}

export function toUserLlmError(err: unknown, fallback = USER_LLM_BUSY): string {
  if (err instanceof Error && err.message === USER_LLM_BUSY) return USER_LLM_BUSY;
  const classified = classifyLlmError(err);
  if (
    classified.retryable ||
    classified.kind === "auth" ||
    classified.kind === "rate_limit" ||
    classified.kind === "server"
  ) {
    return USER_LLM_BUSY;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /GoogleGenerativeAI|generateContent|rate_limit|groq\.com|openai\.com|RESOURCE_EXHAUSTED/i.test(
      msg,
    )
  ) {
    return USER_LLM_BUSY;
  }
  return msg.trim() || fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatChainLog(params: {
  stage?: string;
  step: ChainStep;
  attempt: number;
  classified: ClassifiedLlmError;
  headers: Record<string, string>;
}): string {
  const statusLabel = params.classified.status ?? params.classified.kind;
  const stageBit = params.stage ? `stage=${params.stage} ` : "";
  let line = `[llm] ${stageBit}provider=${params.step.provider} model=${params.step.model} attempt=${params.attempt} status=${statusLabel}`;
  if (params.classified.kind === "rate_limit") {
    const kind = inferRateLimitKind(params.headers);
    line += ` rateLimitKind=${kind}`;
    const headerBits = Object.entries(params.headers)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    if (headerBits) line += ` ${headerBits}`;
  }
  return line;
}

export async function runProviderChain<T>(params: {
  steps: ChainStep[];
  run: (step: ChainStep) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  stage?: string;
  inputChars?: number;
  maxTokens?: number;
  onStepExhausted?: (step: ChainStep, classified: ClassifiedLlmError) => void;
}): Promise<T> {
  const sleep = params.sleep ?? defaultSleep;
  const log = params.log ?? ((line: string) => console.info(line));
  const sameModelRetry = sameModelRetryEnabled();
  const maxAttempts = sameModelRetry ? MAX_ATTEMPTS_PER_MODEL : 1;
  const question = llmRequest.getStore()?.question;
  const steps = filterAvailableSteps(params.steps);
  if (params.inputChars != null || params.maxTokens != null || params.stage) {
    log(
      `[llm] stage=${params.stage ?? "-"} inputChars=${params.inputChars ?? "-"} maxTokens=${params.maxTokens ?? "-"}`,
    );
  }
  for (const [provider, kind] of Object.entries(skippedProviders())) {
    if (kind) log(`[llm] skip provider=${provider} reason=${kind}`);
  }
  if (!steps.length) throw new Error(USER_LLM_BUSY);

  let last: unknown;

  for (let i = 0; i < steps.length; i++) {
    if (isPastAbort()) {
      timingLog("fallback", { reason: "deadline_abort" });
      throw new Error(USER_LLM_BUSY);
    }
    const step = steps[i];
    if (step.provider === "gemini" && shouldSkipSlowQuality()) {
      timingLog("fallback", { reason: "deadline_skip_gemini", provider: "groq" });
      log("[llm] fallback reason=deadline_skip_gemini provider=groq");
      continue;
    }

    let skipRestOfProvider = false;
    let fallbackReason = "exhausted";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (isPastAbort()) {
        timingLog("fallback", { reason: "deadline_abort" });
        throw new Error(USER_LLM_BUSY);
      }
      const started = Date.now();
      try {
        const result = await params.run(step);
        const durationMs = Date.now() - started;
        log(`[llm] success provider=${step.provider} model=${step.model}`);
        timingLog(question != null ? `question=${question}` : "call", {
          provider: step.provider,
          model: step.model,
          attempt,
          durationMs,
          status: "ok",
          stage: params.stage,
        });
        return result;
      } catch (err) {
        last = err;
        const durationMs = Date.now() - started;
        const classified = classifyLlmError(err);
        const headers = extractErrorHeaders(err);
        log(
          formatChainLog({
            stage: params.stage,
            step,
            attempt,
            classified,
            headers,
          }),
        );
        timingLog(question != null ? `question=${question}` : "call", {
          provider: step.provider,
          model: step.model,
          attempt,
          durationMs,
          status: classified.status ?? classified.kind,
          stage: params.stage,
        });
        const decision = decideRetry(err, attempt, sameModelRetry);
        if (decision.action === "retry") {
          log(
            `[llm] retry provider=${step.provider} delayMs=${decision.delayMs}`,
          );
          await sleep(decision.delayMs);
          continue;
        }
        fallbackReason = decision.reason;
        skipRestOfProvider = classified.kind === "auth";
        params.onStepExhausted?.(step, classified);
        rememberExhaustedProvider(step, classified, params.steps);
        break;
      }
    }

    const next = steps.slice(i + 1).find((s) => {
      if (skipRestOfProvider && s.provider === step.provider) return false;
      if (s.provider === "gemini" && shouldSkipSlowQuality()) return false;
      return true;
    });
    if (next) {
      log(
        `[llm] fallback reason=${fallbackReason} provider=${next.provider} model=${next.model}`,
      );
      timingLog("fallback", {
        reason: fallbackReason,
        provider: next.provider,
        model: next.model,
      });
    }

    if (skipRestOfProvider) {
      while (i + 1 < steps.length && steps[i + 1].provider === step.provider) {
        i += 1;
      }
    }
  }

  void last;
  throw new Error(USER_LLM_BUSY);
}

function httpErr(
  status: number,
  message = "",
  headers: Record<string, string> = {},
): Error {
  const err = new Error(message || `HTTP ${status}`) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  err.status = status;
  err.headers = headers;
  return err;
}

export async function runLlmResilienceSelfCheck(): Promise<string> {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  const chainFast = buildRouteChain({
    route: "fast",
    groqModel: "openai/gpt-oss-120b",
    geminiPrimary: "gemini-3.8-flash",
    includeGroq: true,
    includeGemini: true,
  });
  const chainQuality = buildRouteChain({
    route: "quality",
    groqModel: "openai/gpt-oss-120b",
    geminiPrimary: "gemini-3.8-flash",
    includeGroq: true,
    includeGemini: true,
  });

  if (chainFast[0]?.provider !== "groq") throw new Error("fast starts groq");
  if (chainFast[0]?.model !== "openai/gpt-oss-120b") {
    throw new Error("fast groq model");
  }
  if (chainQuality[0]?.model !== "gemini-3.8-flash") {
    throw new Error("quality starts gemini-3.8");
  }
  if (chainQuality[1]?.model !== "gemini-3.7-flash") {
    throw new Error("quality includes 3.7 fallback");
  }
  if (chainQuality[2]?.provider !== "groq") {
    throw new Error("quality ends groq");
  }

  const envPrimary = geminiModelChain("gemini-2.5-flash");
  if (envPrimary[0] !== "gemini-2.5-flash" || envPrimary[1] !== "gemini-3.7-flash") {
    throw new Error("GEMINI_MODEL override should stay first");
  }

  const d15 = decideRetry(httpErr(429, "rate", { "retry-after": "15" }), 1);
  if (d15.action !== "fallback" || d15.reason !== "retry_after_too_long") {
    throw new Error(`retry-after 15s must fallback, got ${JSON.stringify(d15)}`);
  }
  const d1 = decideRetry(httpErr(429, "rate", { "retry-after": "1" }), 1);
  if (d1.action !== "retry" || d1.delayMs !== 1000) {
    throw new Error(`retry-after 1s must retry 1000ms, got ${JSON.stringify(d1)}`);
  }
  const dNone = decideRetry(httpErr(429, "rate"), 1);
  if (dNone.action !== "fallback") {
    throw new Error("headerless 429 must fallback, not guess a short retry");
  }
  const dTpm = decideRetry(
    httpErr(429, "rate", {
      "retry-after": "1",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-remaining-requests": "12",
      "x-ratelimit-reset-tokens": "20s",
    }),
    1,
  );
  if (dTpm.action !== "fallback") {
    throw new Error("TPM reset 20s must fallback even if retry-after is 1s");
  }

  // A. 이전 요청 Groq 429 → 다음 별도 요청에서 Groq 다시 후보
  await runWithLlmRequest(async () => {
    await runProviderChain({
      steps: chainFast,
      sleep,
      log,
      run: async (step) => {
        if (step.provider === "groq") {
          throw httpErr(429, "rate", { "retry-after": "15" });
        }
        return "g";
      },
    });
    if (!isProviderSkipped("groq")) throw new Error("A groq should be skipped in-request");
  });
  await runWithLlmRequest(async () => {
    if (isProviderSkipped("groq")) throw new Error("A groq leaked across requests");
    const aCalls: string[] = [];
    const a = await runProviderChain({
      steps: chainFast,
      sleep,
      log,
      run: async (step) => {
        aCalls.push(step.provider);
        if (step.provider === "groq") return "ok";
        throw new Error("A next request should try groq first");
      },
    });
    if (a !== "ok" || aCalls[0] !== "groq") {
      throw new Error(`A failed calls=${aCalls.join()}`);
    }
  });

  // B. 한 요청 내 Groq 429 → 후속 stage 에서 Groq 를 다시 두드리지 않음
  await runWithLlmRequest(async () => {
    let groqHits = 0;
    await runProviderChain({
      steps: chainFast,
      sleep,
      log,
      run: async (step) => {
        if (step.provider === "groq") {
          groqHits += 1;
          throw httpErr(429, "rate", { "retry-after": "15" });
        }
        return "s1";
      },
    });
    const stage2 = filterAvailableSteps(chainFast);
    if (stage2.some((s) => s.provider === "groq")) {
      throw new Error("B groq still in later-stage chain");
    }
    await runProviderChain({
      steps: chainFast,
      sleep,
      log,
      run: async (step) => {
        if (step.provider === "groq") {
          groqHits += 1;
          throw new Error("B hammered groq");
        }
        return "s2";
      },
    });
    if (groqHits !== 1) throw new Error(`B groqHits=${groqHits}`);
  });

  // C. retry-after 1초 → 1회 retry
  sleeps.length = 0;
  let cGroq = 0;
  const c = await runProviderChain({
    steps: chainFast,
    sleep,
    log,
    run: async (step) => {
      if (step.provider !== "groq") throw new Error("C gemini");
      cGroq += 1;
      if (cGroq === 1) throw httpErr(429, "rate", { "retry-after": "1" });
      return "ok";
    },
  });
  if (c !== "ok" || cGroq !== 2 || sleeps.length !== 1 || sleeps[0] !== 1000) {
    throw new Error(`C failed groq=${cGroq} sleeps=${sleeps.join()}`);
  }

  // D. retry-after 15초 → 2.5초 truncate retry 없이 fallback
  sleeps.length = 0;
  let dGroq = 0;
  let dGemini = 0;
  const d = await runProviderChain({
    steps: chainFast,
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "groq") {
        dGroq += 1;
        throw httpErr(429, "rate", { "retry-after": "15" });
      }
      dGemini += 1;
      return "g38";
    },
  });
  if (d !== "g38" || dGroq !== 1 || dGemini !== 1) {
    throw new Error(`D failed groq=${dGroq} gemini=${dGemini}`);
  }
  if (sleeps.some((ms) => ms === 2500 || ms === 15000 || ms > SHORT_RETRY_AFTER_MS)) {
    throw new Error(`D waited too long: ${sleeps.join()}`);
  }
  if (sleeps.length !== 0) throw new Error(`D should not sleep, sleeps=${sleeps.join()}`);

  // E. Gemini 503 → 짧은 retry 후 fallback
  sleeps.length = 0;
  let e38 = 0;
  let e37 = 0;
  const e = await runProviderChain({
    steps: chainQuality,
    sleep,
    log,
    run: async (step) => {
      if (step.model === "gemini-3.8-flash") {
        e38 += 1;
        throw httpErr(503, "generateContent");
      }
      if (step.model === "gemini-3.7-flash") {
        e37 += 1;
        return "g37";
      }
      throw new Error("E groq");
    },
  });
  if (e !== "g37" || e38 !== 2 || e37 !== 1) {
    throw new Error(`E failed 38=${e38} 37=${e37}`);
  }
  if (sleeps.length !== 1 || sleeps[0] !== SERVER_RETRY_MS) {
    throw new Error(`E backoff ${sleeps.join()}`);
  }

  // F. 전 provider 실패 → sanitized
  try {
    await runProviderChain({
      steps: chainFast,
      sleep,
      log,
      run: async () => {
        throw httpErr(503, "GoogleGenerativeAI Fetch [503 Service Unavailable]");
      },
    });
    throw new Error("F should throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== USER_LLM_BUSY) throw new Error(`F unsanitized: ${msg}`);
    if (/GoogleGenerativeAI|503 Service/.test(msg)) {
      throw new Error("F leaked SDK");
    }
  }

  // G. 401/403/invalid model → retry 없음
  sleeps.length = 0;
  let gGroq = 0;
  const g401 = await runProviderChain({
    steps: chainFast,
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "groq") {
        gGroq += 1;
        throw httpErr(401, "unauthorized");
      }
      return "ok";
    },
  });
  if (g401 !== "ok" || gGroq !== 1 || sleeps.length !== 0) {
    throw new Error(`G 401 groq=${gGroq} sleeps=${sleeps.join()}`);
  }

  let g38 = 0;
  let g37 = 0;
  await runProviderChain({
    steps: chainQuality,
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "gemini" && step.model === "gemini-3.8-flash") {
        g38 += 1;
        throw httpErr(403, "forbidden");
      }
      if (step.provider === "gemini") g37 += 1;
      return "ok";
    },
  });
  if (g38 !== 1 || g37 !== 0) {
    throw new Error(`G 403 should skip other gemini models 38=${g38} 37=${g37}`);
  }

  let gInv = 0;
  await runProviderChain({
    steps: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "gemini", model: "gemini-3.8-flash" },
    ],
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "groq") {
        gInv += 1;
        throw httpErr(404, "invalid model");
      }
      return "ok";
    },
  });
  if (gInv !== 1) throw new Error(`G invalid groq retries ${gInv}`);

  const cls429 = classifyLlmError(httpErr(429));
  if (!cls429.retryable || cls429.kind !== "rate_limit") {
    throw new Error("classify 429");
  }
  const cls503 = classifyLlmError({
    message: "[GoogleGenerativeAI Error] generateContent: [503 Service Unavailable]",
    status: 503,
  });
  if (!cls503.retryable || cls503.status !== 503) throw new Error("classify 503");
  const cls401 = classifyLlmError(httpErr(401));
  if (cls401.retryable) throw new Error("classify 401");

  const tpmKind = inferRateLimitKind({
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-remaining-requests": "5",
  });
  if (tpmKind !== "tpm") throw new Error(`infer tpm got ${tpmKind}`);

  const dInteractive429 = decideRetry(
    httpErr(429, "rate", { "retry-after": "1" }),
    1,
    false,
  );
  if (dInteractive429.action !== "fallback") {
    throw new Error("interactive 429 must not same-model retry");
  }
  const dInteractive503 = decideRetry(httpErr(503), 1, false);
  if (dInteractive503.action !== "fallback") {
    throw new Error("interactive 503 must not same-model retry");
  }

  if (REQUEST_ABORT_MS !== 260_000) {
    throw new Error("interactive abort deadline must be 260s");
  }
  if (REQUEST_ABORT_MS + LLM_CALL_TIMEOUT_MS !== 285_000) {
    throw new Error("abort + per-call timeout must be 285s");
  }
  if (REQUEST_ABORT_MS + LLM_CALL_TIMEOUT_MS >= VERCEL_MAX_DURATION_MS) {
    throw new Error("in-flight timeout would still hit Vercel 300s");
  }

  // H. interactive: Gemini 503 → same 3.8 retry 없이 3.7
  sleeps.length = 0;
  let h38 = 0;
  let h37 = 0;
  const h = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.model === "gemini-3.8-flash") {
            h38 += 1;
            throw httpErr(503, "generateContent");
          }
          if (step.model === "gemini-3.7-flash") {
            h37 += 1;
            return "g37";
          }
          throw new Error("H groq");
        },
      }),
    { interactive: true },
  );
  if (h !== "g37" || h38 !== 1 || h37 !== 1 || sleeps.length !== 0) {
    throw new Error(`H interactive 503 groq-path 38=${h38} 37=${h37} sleeps=${sleeps.join()}`);
  }

  // I. interactive: retry-after 1s 429 → wait 없이 다음 모델
  sleeps.length = 0;
  let i38 = 0;
  let i37 = 0;
  const iRes = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.model === "gemini-3.8-flash") {
            i38 += 1;
            throw httpErr(429, "rate", { "retry-after": "1" });
          }
          if (step.model === "gemini-3.7-flash") {
            i37 += 1;
            return "g37";
          }
          throw new Error("I groq");
        },
      }),
    { interactive: true },
  );
  if (iRes !== "g37" || i38 !== 1 || i37 !== 1 || sleeps.length !== 0) {
    throw new Error(`I interactive 429 38=${i38} 37=${i37} sleeps=${sleeps.join()}`);
  }

  // J. timeout → 다음 모델, same-model retry 없음
  let j38 = 0;
  let j37 = 0;
  const j = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.model === "gemini-3.8-flash") {
            j38 += 1;
            throw llmCallTimeoutError(25_000);
          }
          if (step.model === "gemini-3.7-flash") {
            j37 += 1;
            return "g37";
          }
          throw new Error("J groq");
        },
      }),
    { interactive: true },
  );
  if (j !== "g37" || j38 !== 1 || j37 !== 1) {
    throw new Error(`J timeout fallback 38=${j38} 37=${j37}`);
  }

  // K. soft deadline → Gemini skip, Groq 우선
  let kGemini = 0;
  let kGroq = 0;
  const k = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.provider === "gemini") {
            kGemini += 1;
            throw new Error("K gemini should be skipped");
          }
          kGroq += 1;
          return "groq";
        },
      }),
    { interactive: true, startedAt: Date.now() - REQUEST_SOFT_DEADLINE_MS - 1 },
  );
  if (k !== "groq" || kGemini !== 0 || kGroq !== 1) {
    throw new Error(`K deadline skip gemini=${kGemini} groq=${kGroq}`);
  }

  // L. abort deadline → JSON busy, provider 호출 없음
  let lCalls = 0;
  try {
    await runWithLlmRequest(
      () =>
        runProviderChain({
          steps: chainQuality,
          sleep,
          log,
          run: async () => {
            lCalls += 1;
            return "nope";
          },
        }),
      { interactive: true, startedAt: Date.now() - REQUEST_ABORT_MS - 1 },
    );
    throw new Error("L should throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== USER_LLM_BUSY) throw new Error(`L unsanitized: ${msg}`);
    if (lCalls !== 0) throw new Error(`L still called providers ${lCalls}`);
  }

  const t0 = Date.now();
  try {
    await withCallTimeout(new Promise((r) => setTimeout(r, 5_000)), 40);
    throw new Error("withCallTimeout should reject");
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "AbortError") {
      throw new Error("withCallTimeout kind");
    }
    if (Date.now() - t0 > 400) throw new Error("withCallTimeout too slow");
  }
  const clsTimeout = classifyLlmError(llmCallTimeoutError());
  if (!clsTimeout.retryable || clsTimeout.kind !== "timeout") {
    throw new Error("classify timeout");
  }

  void logs;
  return "ok";
}
