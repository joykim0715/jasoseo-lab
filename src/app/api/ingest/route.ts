import { NextRequest, NextResponse } from "next/server";
import { ingestFromText } from "@/lib/ingest/parseText";
import { ingestFromUrl } from "@/lib/ingest/parseUrl";
import { ingestFromFile } from "@/lib/ingest/parseFile";
import { ingestFromImage } from "@/lib/ingest/parseImage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const mode = String(form.get("mode") ?? "");
      const file = form.get("file");

      if (!(file instanceof File)) {
        return NextResponse.json({ error: "파일이 필요합니다." }, { status: 400 });
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      if (mode === "image") {
        const job = await ingestFromImage({
          buffer,
          mimeType: file.type || "image/png",
        });
        return NextResponse.json({ job });
      }

      if (mode === "file") {
        const job = await ingestFromFile({
          buffer,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
        });
        return NextResponse.json({ job });
      }

      return NextResponse.json({ error: "지원하지 않는 mode입니다." }, { status: 400 });
    }

    const body = (await req.json()) as {
      mode?: string;
      text?: string;
      url?: string;
    };

    if (body.mode === "text") {
      const job = await ingestFromText(body.text ?? "");
      return NextResponse.json({ job });
    }

    if (body.mode === "url") {
      const job = await ingestFromUrl(body.url ?? "");
      return NextResponse.json({ job });
    }

    return NextResponse.json({ error: "mode가 필요합니다." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "공고 분석에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
