import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

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

function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = `${err.name} ${err.message}`.toLowerCase();
  if (msg.includes("json") && msg.includes("parse")) return false;
  return true;
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
        return await runGemini();
      }
      throw err;
    }
  }

  return await runGemini();
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

export async function llmJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const text = await llmText({
    ...params,
    system: `${params.system}\n\nRespond with valid JSON only. No markdown fences.`,
  });
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
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
