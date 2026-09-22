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

/** last-provider 429 recovery wait 상한. 전역 SHORT_RETRY_AFTER_MS 와 별개 */
export const LAST_PROVIDER_RECOVERY_MAX_WAIT_MS = 15_000;

export type LlmProvider = "groq" | "openai" | "gemini";

export type LlmErrorKind =
  | "rate_limit"
  | "server"
  | "timeout"
  | "auth"
  | "invalid"
  | "empty_output"
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

export class UserLlmBusyError extends Error {
  readonly provider?: LlmProvider;
  readonly model?: string;
  readonly status?: number;
  readonly kind?: LlmErrorKind;
  readonly rateLimit?: Record<string, string>;

  constructor(ctx?: {
    provider?: LlmProvider;
    model?: string;
    status?: number;
    kind?: LlmErrorKind;
    rateLimit?: Record<string, string>;
  }) {
    super(USER_LLM_BUSY);
    this.name = "UserLlmBusyError";
    this.provider = ctx?.provider;
    this.model = ctx?.model;
    this.status = ctx?.status;
    this.kind = ctx?.kind;
    this.rateLimit = ctx?.rateLimit;
  }
}

export class UnusableLlmOutputError extends Error {
  constructor() {
    super("UNUSABLE_LLM_OUTPUT");
    this.name = "UnusableLlmOutputError";
  }
}

export function essayBodyChars(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const body = (value as { body?: unknown }).body;
  return typeof body === "string" ? body.trim().length : 0;
}

export function recoverReviseBody(original: string, revised: unknown): string {
  const r = typeof revised === "string" ? revised.trim() : "";
  if (r) return r;
  const o = original.trim();
  if (o) return o;
  throw new UnusableLlmOutputError();
}

export function lastProviderRecoveryWaitMs(err: unknown): number | undefined {
  const headers = extractErrorHeaders(err);
  const retryAfter = parseDurationMs(headers["retry-after"]);
  if (retryAfter != null) return retryAfter;
  const tokRaw = headers["x-ratelimit-remaining-tokens"];
  const tokN = tokRaw != null && tokRaw !== "" ? Number(tokRaw) : undefined;
  if (tokN !== 0) return undefined;
  return parseDurationMs(headers["x-ratelimit-reset-tokens"]);
}

export function assertUsableEssayBody(parsed: unknown): void {
  if (essayBodyChars(parsed) <= 0) throw new UnusableLlmOutputError();
}

export function llmBusyTelemetry(err: unknown): {
  provider?: LlmProvider;
  model?: string;
  status?: number;
  kind?: LlmErrorKind;
  rateLimit?: Record<string, string>;
} {
  if (err instanceof UserLlmBusyError) {
    return {
      provider: err.provider,
      model: err.model,
      status: err.status,
      kind: err.kind,
      rateLimit: err.rateLimit,
    };
  }
  const classified = classifyLlmError(err);
  return { status: classified.status, kind: classified.kind };
}

export function canLastProviderRecover(waitMs: number): boolean {
  if (!Number.isFinite(waitMs) || waitMs < 0) return false;
  if (waitMs > LAST_PROVIDER_RECOVERY_MAX_WAIT_MS) return false;
  const store = llmRequest.getStore();
  if (!store?.interactive) return false;
  const elapsed = Date.now() - store.startedAt;
  return elapsed + waitMs + LLM_CALL_TIMEOUT_MS < store.abortMs;
}

function busyError(
  step?: ChainStep,
  classified?: ClassifiedLlmError,
  headers?: Record<string, string>,
): UserLlmBusyError {
  const rateLimit = headers && Object.keys(headers).length ? headers : undefined;
  return new UserLlmBusyError({
    provider: step?.provider,
    model: step?.model,
    status: classified?.status,
    kind: classified?.kind,
    rateLimit,
  });
}

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
  if (err instanceof UserLlmBusyError) {
    return {
      retryable: false,
      status: err.status,
      kind: err.kind ?? "other",
    };
  }
  if (err instanceof UnusableLlmOutputError) {
    return { retryable: false, kind: "empty_output" };
  }
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
  if (err instanceof UserLlmBusyError) return USER_LLM_BUSY;
  if (err instanceof Error && err.message === USER_LLM_BUSY) return USER_LLM_BUSY;
  const classified = classifyLlmError(err);
  if (
    classified.retryable ||
    classified.kind === "auth" ||
    classified.kind === "rate_limit" ||
    classified.kind === "server" ||
    classified.kind === "empty_output"
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
  if (!steps.length) throw new UserLlmBusyError();

  const nextRunnable = (from: number, skipRestOfProvider: boolean, provider: LlmProvider) =>
    steps.slice(from + 1).find((s) => {
      if (skipRestOfProvider && s.provider === provider) return false;
      if (s.provider === "gemini" && shouldSkipSlowQuality()) return false;
      return true;
    });

  let lastStep: ChainStep | undefined;
  let lastClassified: ClassifiedLlmError | undefined;
  let lastHeaders: Record<string, string> | undefined;

  for (let i = 0; i < steps.length; i++) {
    if (isPastAbort()) {
      timingLog("fallback", { reason: "deadline_abort" });
      throw new UserLlmBusyError({ kind: "timeout" });
    }
    const step = steps[i];
    if (step.provider === "gemini" && shouldSkipSlowQuality()) {
      timingLog("fallback", { reason: "deadline_skip_gemini", provider: "groq" });
      log("[llm] fallback reason=deadline_skip_gemini provider=groq");
      continue;
    }

    let skipRestOfProvider = false;
    let fallbackReason = "exhausted";
    let recoveryUsed = false;
    let attempt = 0;

    while (true) {
      if (isPastAbort()) {
        timingLog("fallback", { reason: "deadline_abort" });
        throw new UserLlmBusyError({ kind: "timeout" });
      }
      attempt += 1;
      if (attempt > maxAttempts + 1) {
        fallbackReason = "attempts_exhausted";
        break;
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
        lastStep = step;
        const durationMs = Date.now() - started;
        const classified = classifyLlmError(err);
        const headers = extractErrorHeaders(err);
        lastClassified = classified;
        lastHeaders = headers;
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
        if (decision.action === "retry" && attempt < maxAttempts) {
          log(
            `[llm] retry provider=${step.provider} delayMs=${decision.delayMs}`,
          );
          await sleep(decision.delayMs);
          continue;
        }
        const fallbackFrom =
          decision.action === "fallback" ? decision.reason : classified.kind;
        // last-provider 429 recovery is exactly once; never re-enter after it is spent
        if (recoveryUsed) {
          fallbackReason = fallbackFrom;
          skipRestOfProvider = classified.kind === "auth";
          params.onStepExhausted?.(step, classified);
          rememberExhaustedProvider(step, classified, params.steps);
          break;
        }
        const isLast = !nextRunnable(i, classified.kind === "auth", step.provider);
        if (classified.kind === "rate_limit" && isLast) {
          const waitMs = lastProviderRecoveryWaitMs(err);
          if (waitMs != null && canLastProviderRecover(waitMs)) {
            recoveryUsed = true;
            log(
              `[llm] retry provider=${step.provider} delayMs=${waitMs} reason=last_provider_recovery`,
            );
            timingLog("fallback", {
              reason: "last_provider_recovery",
              provider: step.provider,
              model: step.model,
              delayMs: waitMs,
            });
            await sleep(waitMs);
            continue;
          }
        }
        fallbackReason = fallbackFrom;
        skipRestOfProvider = classified.kind === "auth";
        params.onStepExhausted?.(step, classified);
        rememberExhaustedProvider(step, classified, params.steps);
        break;
      }
    }

    const next = nextRunnable(i, skipRestOfProvider, step.provider);
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

  throw busyError(lastStep, lastClassified, lastHeaders);
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

  if (LAST_PROVIDER_RECOVERY_MAX_WAIT_MS !== 15_000) {
    throw new Error("last-provider recovery wait cap must stay 15s");
  }
  if (SHORT_RETRY_AFTER_MS !== 3000) {
    throw new Error("global SHORT_RETRY_AFTER_MS must stay 3000");
  }

  // 1. intermediate Gemini 429 retry-after=9 → 대기 없이 다음 provider
  sleeps.length = 0;
  let t1_38 = 0;
  let t1_37 = 0;
  const t1 = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.model === "gemini-3.8-flash") {
            t1_38 += 1;
            throw httpErr(429, "rate", { "retry-after": "9" });
          }
          if (step.model === "gemini-3.7-flash") {
            t1_37 += 1;
            return "g37";
          }
          throw new Error("1 groq");
        },
      }),
    { interactive: true },
  );
  if (t1 !== "g37" || t1_38 !== 1 || t1_37 !== 1 || sleeps.length !== 0) {
    throw new Error(`1 gemini 429 wait 38=${t1_38} 37=${t1_37} sleeps=${sleeps.join()}`);
  }

  // 2. last Groq 429 retry-after=9, budget ok → 9s wait, 1 retry success
  sleeps.length = 0;
  let t2g = 0;
  const t2 = await runWithLlmRequest(
    () =>
      runProviderChain({
        steps: chainQuality,
        sleep,
        log,
        run: async (step) => {
          if (step.provider === "gemini") {
            throw httpErr(429, "rate", { "retry-after": "20" });
          }
          t2g += 1;
          if (t2g === 1) throw httpErr(429, "rate", { "retry-after": "9" });
          return "groq-ok";
        },
      }),
    { interactive: true },
  );
  if (t2 !== "groq-ok" || t2g !== 2 || sleeps.join() !== "9000") {
    throw new Error(`2 last recovery groq=${t2g} sleeps=${sleeps.join()}`);
  }

  // 3. last retry-after=16 → no recovery → USER_LLM_BUSY
  sleeps.length = 0;
  let t3g = 0;
  try {
    await runWithLlmRequest(
      () =>
        runProviderChain({
          steps: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
          sleep,
          log,
          run: async () => {
            t3g += 1;
            throw httpErr(429, "rate", { "retry-after": "16" });
          },
        }),
      { interactive: true },
    );
    throw new Error("3 should throw");
  } catch (err) {
    if (!(err instanceof UserLlmBusyError)) throw new Error("3 type");
    if (err.message !== USER_LLM_BUSY) throw new Error("3 message");
    if (t3g !== 1 || sleeps.length !== 0) {
      throw new Error(`3 groq=${t3g} sleeps=${sleeps.join()}`);
    }
  }

  // 4. retry-after=9 but abort budget insufficient → no recovery
  sleeps.length = 0;
  let t4g = 0;
  const t4Elapsed = REQUEST_ABORT_MS - 1_000;
  try {
    await runWithLlmRequest(
      () =>
        runProviderChain({
          steps: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
          sleep,
          log,
          run: async () => {
            t4g += 1;
            throw httpErr(429, "rate", { "retry-after": "9" });
          },
        }),
      { interactive: true, startedAt: Date.now() - t4Elapsed },
    );
    throw new Error("4 should throw");
  } catch (err) {
    if (!(err instanceof UserLlmBusyError)) throw new Error("4 type");
    if (t4g !== 1 || sleeps.length !== 0) {
      throw new Error(`4 groq=${t4g} sleeps=${sleeps.join()}`);
    }
  }

  // 5. recovery retry also 429 → no second retry
  sleeps.length = 0;
  let t5g = 0;
  try {
    await runWithLlmRequest(
      () =>
        runProviderChain({
          steps: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
          sleep,
          log,
          run: async () => {
            t5g += 1;
            throw httpErr(429, "rate", { "retry-after": "9" });
          },
        }),
      { interactive: true },
    );
    throw new Error("5 should throw");
  } catch (err) {
    if (!(err instanceof UserLlmBusyError)) throw new Error("5 type");
    if (t5g !== 2 || sleeps.join() !== "9000") {
      throw new Error(`5 groq=${t5g} sleeps=${sleeps.join()}`);
    }
  }

  // 6. HTTP/JSON success, body missing → usable failure → next provider
  const t6 = await runProviderChain({
    steps: [
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "gemini") {
        assertUsableEssayBody({ title: "x" });
        return { body: "should-not" };
      }
      assertUsableEssayBody({ body: "usable draft" });
      return { body: "usable draft" };
    },
  });
  if ((t6 as { body: string }).body !== "usable draft") throw new Error("6 fallback");

  // 7. body="" / whitespace → same
  const t7 = await runProviderChain({
    steps: [
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "gemini") {
        assertUsableEssayBody({ body: "  \n" });
        return { body: "  \n" };
      }
      assertUsableEssayBody({ body: "ok" });
      return { body: "ok" };
    },
  });
  if ((t7 as { body: string }).body !== "ok") throw new Error("7 whitespace");
  const t7empty = await runProviderChain({
    steps: [
      { provider: "gemini", model: "gemini-3.7-flash" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    sleep,
    log,
    run: async (step) => {
      if (step.provider === "gemini") {
        assertUsableEssayBody({ body: "" });
        return { body: "" };
      }
      return { body: "ok" };
    },
  });
  if ((t7empty as { body: string }).body !== "ok") throw new Error("7 empty string");

  // 8. revise empty + original non-empty → original
  if (recoverReviseBody("원문 유지", "") !== "원문 유지") {
    throw new Error("8 original not kept");
  }
  if (recoverReviseBody("원문", "  ") !== "원문") {
    throw new Error("8 whitespace revise");
  }

  // 9. original empty + revise empty → not success
  try {
    recoverReviseBody("", "");
    throw new Error("9 should throw");
  } catch (err) {
    if (!(err instanceof UnusableLlmOutputError)) throw new Error("9 type");
  }
  try {
    recoverReviseBody("  ", null);
    throw new Error("9b should throw");
  } catch (err) {
    if (!(err instanceof UnusableLlmOutputError)) throw new Error("9b type");
  }
  if (essayBodyChars({ body: null }) !== 0) throw new Error("9c null body");
  if (essayBodyChars({}) !== 0) throw new Error("9d missing body");

  // 10. USER_LLM_BUSY telemetry keeps first provider/model/status
  try {
    await runWithLlmRequest(
      () =>
        runProviderChain({
          steps: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
          sleep,
          log,
          run: async () => {
            throw httpErr(429, "rate", { "retry-after": "16" });
          },
        }),
      { interactive: true },
    );
    throw new Error("10 should throw");
  } catch (err) {
    if (!(err instanceof UserLlmBusyError)) throw new Error("10 type");
    const tel = llmBusyTelemetry(err);
    if (tel.provider !== "groq" || tel.model !== "openai/gpt-oss-120b") {
      throw new Error(`10 provider ${tel.provider}/${tel.model}`);
    }
    if (tel.status !== 429 || tel.kind !== "rate_limit") {
      throw new Error(`10 status ${tel.status} kind ${tel.kind}`);
    }
    if (tel.rateLimit?.["retry-after"] !== "16") {
      throw new Error("10 retry-after metadata lost");
    }
    if (err.message !== USER_LLM_BUSY) throw new Error("10 ui message");
    const rethrown = err;
    const tel2 = llmBusyTelemetry(rethrown);
    if (tel2.status !== 429 || tel2.provider !== "groq") {
      throw new Error("10 rethrow lost metadata");
    }
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
