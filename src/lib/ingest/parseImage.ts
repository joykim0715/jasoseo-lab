import { claudeVisionText } from "../claude";
import { structureJobPosting } from "./structureJd";
import type { JobPosting } from "../types";

const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

export async function ingestFromImage(params: {
  buffer: Buffer;
  mimeType: string;
}): Promise<JobPosting> {
  if (params.buffer.byteLength > MAX_BYTES) {
    throw new Error("이미지 크기는 8MB 이하여야 합니다.");
  }

  const mediaType = ALLOWED[params.mimeType.toLowerCase()];
  if (!mediaType) {
    throw new Error("지원 이미지: JPEG, PNG, GIF, WebP");
  }

  const warnings: string[] = [];
  const base64 = params.buffer.toString("base64");

  const ocr = await claudeVisionText({
    system:
      "You extract Korean job posting text from screenshots. Return plain text of the posting only. If unreadable, say so.",
    user: "이 이미지에서 채용 공고 텍스트를 모두 추출해 주세요.",
    mediaType,
    base64,
    maxTokens: 4000,
  });

  if (ocr.length < 40 || /읽을 수 없|unreadable|too blurry/i.test(ocr)) {
    warnings.push(
      "이미지 인식 품질이 낮습니다. 더 선명한 스크린샷으로 다시 업로드해 주세요.",
    );
  }

  return structureJobPosting(ocr, warnings);
}
