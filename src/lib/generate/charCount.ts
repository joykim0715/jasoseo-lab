export function countChars(text: string, countSpaces: boolean): number {
  if (countSpaces) return [...text].length;
  return [...text.replace(/\s/g, "")].length;
}

export function isWithinLimit(
  text: string,
  limit: number,
  countSpaces: boolean,
): boolean {
  if (limit <= 0) return true;
  return countChars(text, countSpaces) <= limit;
}

/** LLM 없이 글자 수 상한만 자른다. */
export function clipToCharLimit(
  text: string,
  limit: number,
  countSpaces: boolean,
): string {
  if (limit <= 0 || isWithinLimit(text, limit, countSpaces)) return text;
  const chars = [...text];
  if (countSpaces) return chars.slice(0, limit).join("");
  let count = 0;
  let out = "";
  for (const ch of chars) {
    if (/\s/.test(ch)) {
      out += ch;
    } else {
      if (count >= limit) break;
      out += ch;
      count += 1;
    }
  }
  return out;
}
