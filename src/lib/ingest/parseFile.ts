import mammoth from "mammoth";
import { structureJobPosting } from "./structureJd";
import type { JobPosting } from "../types";

const MAX_BYTES = 12 * 1024 * 1024;

function polyfillPdfDom() {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class {};
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class {
      data = new Uint8ClampedArray(4);
      width = 1;
      height = 1;
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class {};
  }
}

export async function ingestFromFile(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<JobPosting> {
  if (params.buffer.byteLength > MAX_BYTES) {
    throw new Error("파일 크기는 12MB 이하여야 합니다.");
  }

  const name = params.filename.toLowerCase();
  const mime = params.mimeType.toLowerCase();
  const warnings: string[] = [];
  let text = "";

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    polyfillPdfDom();
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: params.buffer });
    try {
      const result = await parser.getText();
      text =
        typeof result === "string"
          ? result
          : ((result as { text?: string }).text ?? "");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    if (text.trim().length < 40) {
      warnings.push(
        "PDF에서 텍스트를 거의 추출하지 못했습니다. 스캔본이면 이미지로 업로드해 주세요.",
      );
    }
  } else if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    name.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer: params.buffer });
    text = result.value;
    if (result.messages?.length) {
      warnings.push("DOCX 일부 서식/이미지는 무시되었습니다.");
    }
  } else if (mime.startsWith("text/") || name.endsWith(".txt")) {
    text = params.buffer.toString("utf8");
  } else {
    throw new Error("지원 형식: PDF, DOCX, TXT (이미지는 이미지 탭 사용)");
  }

  if (!text.trim()) {
    throw new Error("파일에서 텍스트를 읽지 못했습니다. 이미지 OCR을 시도해 주세요.");
  }

  return structureJobPosting(text, warnings);
}
