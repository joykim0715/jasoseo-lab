import { collectPaginatedAPI } from "@notionhq/client";
import type { EssayArchiveItem, ExperienceEpisode } from "../types";
import {
  getNotionClient,
  multiSelect,
  number,
  rich,
  select,
  title,
} from "./client";

type NotionPage = {
  id: string;
  properties: Record<string, unknown>;
};

async function resolveDataSourceId(databaseOrDataSourceId: string): Promise<string> {
  const client = getNotionClient();
  if (!client) throw new Error("Notion client unavailable");

  try {
    const db = await client.databases.retrieve({
      database_id: databaseOrDataSourceId,
    });
    const sources =
      "data_sources" in db
        ? (db as { data_sources?: { id: string }[] }).data_sources
        : undefined;
    if (sources?.[0]?.id) return sources[0].id;
  } catch {
    // ID may already be a data source id
  }

  return databaseOrDataSourceId;
}

async function queryAll(databaseOrDataSourceId: string): Promise<NotionPage[]> {
  const client = getNotionClient();
  if (!client) return [];

  const dataSourceId = await resolveDataSourceId(databaseOrDataSourceId);
  const results = await collectPaginatedAPI(client.dataSources.query, {
    data_source_id: dataSourceId,
  });

  return results
    .filter((page): page is typeof page & { properties: Record<string, unknown> } =>
      Boolean(page && typeof page === "object" && "properties" in page),
    )
    .map((page) => ({
      id: page.id,
      properties: page.properties as Record<string, unknown>,
    }));
}

function asReferenceType(
  raw?: string,
): EssayArchiveItem["referenceType"] {
  const t = (raw ?? "").trim().toLowerCase();
  if (["baseline", "기준", "기준본"].includes(t)) return "baseline";
  if (["final", "제출", "최종"].includes(t)) return "final";
  if (["draft", "초안"].includes(t)) return "draft";
  if (["reference", "참고"].includes(t)) return "reference";
  return undefined;
}

export async function loadNotionExperiences(): Promise<ExperienceEpisode[]> {
  const dbId = process.env.NOTION_EXPERIENCE_DB_ID;
  if (!dbId || !getNotionClient()) return [];

  try {
    const pages = await queryAll(dbId);
    return pages.map((page) => {
      const props = page.properties;
      const name = title(props.Name) || "Untitled";
      return {
        id: page.id,
        title: name,
        role: select(props.Role),
        situation: rich(props.Situation) || undefined,
        task: rich(props.Task) || undefined,
        action: rich(props.Action) || undefined,
        result: rich(props.Result) || undefined,
        metrics: rich(props.Metrics) || undefined,
        highlights: [
          rich(props.Situation),
          rich(props.Task),
          rich(props.Action),
          rich(props.Result),
          rich(props.Metrics),
        ].filter(Boolean),
        tags: multiSelect(props.Tags),
        skills: multiSelect(props.Skills),
        portfolioWorkId: rich(props.PortfolioWorkId) || undefined,
        preferredQuestions: multiSelect(props.PreferredQuestions),
        source: "notion" as const,
      };
    });
  } catch (err) {
    console.error("Notion Experience Bank load failed:", err);
    return [];
  }
}

export async function loadNotionEssays(): Promise<EssayArchiveItem[]> {
  const dbId = process.env.NOTION_ESSAY_DB_ID;
  if (!dbId || !getNotionClient()) return [];

  try {
    const pages = await queryAll(dbId);
    return pages.map((page) => {
      const props = page.properties;
      return {
        id: page.id,
        name: title(props.Name) || "Untitled",
        company: rich(props.Company) || undefined,
        role: rich(props.Role) || undefined,
        question: rich(props.Question),
        answer: rich(props.Answer),
        charCount: number(props.CharCount),
        tone: select(props.Tone),
        rating: select(props.Rating),
        referenceType: asReferenceType(
          select(props.ReferenceType) ||
            select(props.Type) ||
            select(props.Reference),
        ),
      };
    });
  } catch (err) {
    console.error("Notion Essay Archive load failed:", err);
    return [];
  }
}
