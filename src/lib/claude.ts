import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다. .env.local을 확인하세요.");
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";

export async function claudeText(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const anthropic = getAnthropic();
  const res = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  });
  const block = res.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

export async function claudeJson<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const text = await claudeText({
    ...params,
    system: `${params.system}\n\nRespond with valid JSON only. No markdown fences.`,
  });
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned) as T;
}

export async function claudeVisionText(params: {
  system: string;
  user: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
  maxTokens?: number;
}): Promise<string> {
  const anthropic = getAnthropic();
  const res = await anthropic.messages.create({
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
