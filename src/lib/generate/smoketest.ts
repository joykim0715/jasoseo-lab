import { readFileSync } from "fs";
import path from "path";

function applyEnvFile(file: string) {
  try {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const i = trimmed.indexOf("=");
      if (i < 1) continue;
      const k = trimmed.slice(0, i).trim();
      let v = trimmed.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no local env file */
  }
}

async function main() {
  applyEnvFile(path.join(process.cwd(), ".env.local"));
  applyEnvFile(path.join(process.cwd(), ".env"));

  const {
    GEMINI_MODEL,
    GROQ_MODEL,
    getLastLlmCall,
    llmJson,
    llmText,
    SchemaType,
  } = await import("../llm");

  const groqKey = Boolean(process.env.GROQ_API_KEY);
  const geminiKey = Boolean(process.env.GEMINI_API_KEY);
  console.log(`GROQ_MODEL=${GROQ_MODEL}`);
  console.log(`GEMINI_MODEL=${GEMINI_MODEL}`);
  console.log(`GROQ_API_KEY=${groqKey ? "set" : "missing"}`);
  console.log(`GEMINI_API_KEY=${geminiKey ? "set" : "missing"}`);

  if (groqKey) {
    const text = await llmText({
      route: "fast",
      system: "Reply with exactly one word: pong",
      user: "ping",
      maxTokens: 16,
    });
    const call = getLastLlmCall();
    console.log(
      `GROQ_TEXT ${call?.provider}/${call?.model} len=${text.length} ${text ? "PASS" : "FAIL"}`,
    );
    const json = await llmJson<{ ok: boolean }>({
      route: "fast",
      system: "Return JSON only.",
      user: '{"ok": true}',
      maxTokens: 64,
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: { ok: { type: SchemaType.BOOLEAN } },
        required: ["ok"],
      },
    });
    const callJ = getLastLlmCall();
    console.log(
      `GROQ_JSON ${callJ?.provider}/${callJ?.model} ok=${String(json.ok)} ${callJ?.provider === "groq" ? "PASS" : "FAIL"}`,
    );
  } else {
    console.log("GROQ MANUAL TEST REQUIRED (no key)");
  }

  if (geminiKey) {
    const text = await llmText({
      route: "quality",
      system: "Reply with exactly one word: pong",
      user: "ping",
      maxTokens: 16,
    });
    const call = getLastLlmCall();
    console.log(
      `GEMINI_TEXT ${call?.provider}/${call?.model} len=${text.length} ${call?.provider === "gemini" && text ? "PASS" : "FAIL"}`,
    );
    const json = await llmJson<{ ok: boolean }>({
      route: "quality",
      system: "Return JSON only.",
      user: '{"ok": true}',
      maxTokens: 64,
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: { ok: { type: SchemaType.BOOLEAN } },
        required: ["ok"],
      },
    });
    const callJ = getLastLlmCall();
    console.log(
      `GEMINI_JSON ${callJ?.provider}/${callJ?.model} ok=${String(json.ok)} ${callJ?.provider === "gemini" ? "PASS" : "FAIL"}`,
    );
  } else {
    console.log("GEMINI MANUAL TEST REQUIRED (no key)");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
