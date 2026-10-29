/** Local-only whitespace cleanup. Never infer, summarize, or remove clinical words. */
export function formatRecordLocally(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
