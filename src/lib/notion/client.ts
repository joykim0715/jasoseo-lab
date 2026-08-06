import { Client } from "@notionhq/client";

export function getNotionClient(): Client | null {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  return new Client({ auth: token });
}

export function notionConfigured() {
  return Boolean(
    process.env.NOTION_TOKEN &&
      process.env.NOTION_EXPERIENCE_DB_ID &&
      process.env.NOTION_ESSAY_DB_ID,
  );
}

function plain(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => {
      if (r && typeof r === "object" && "plain_text" in r) {
        return String((r as { plain_text: string }).plain_text);
      }
      return "";
    })
    .join("");
}

function multiSelect(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const p = prop as { type?: string; multi_select?: { name: string }[] };
  if (p.type === "multi_select" && Array.isArray(p.multi_select)) {
    return p.multi_select.map((m) => m.name);
  }
  return [];
}

function select(prop: unknown): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as { type?: string; select?: { name: string } | null };
  if (p.type === "select" && p.select) return p.select.name;
  return undefined;
}

function number(prop: unknown): number | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as { type?: string; number?: number | null };
  if (p.type === "number" && typeof p.number === "number") return p.number;
  return undefined;
}

function title(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const p = prop as { type?: string; title?: unknown };
  if (p.type === "title") return plain(p.title);
  return "";
}

function rich(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const p = prop as { type?: string; rich_text?: unknown };
  if (p.type === "rich_text") return plain(p.rich_text);
  return "";
}

export {
  plain,
  multiSelect,
  select,
  number,
  title,
  rich,
};
