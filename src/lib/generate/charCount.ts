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
