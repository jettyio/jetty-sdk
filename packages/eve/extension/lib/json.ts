/** Tolerant JSON extraction shared by the ingest hook and the judge path. */

/** Pull the first {...} JSON object out of model text (tolerates fences/prose). */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The judge's full verdict, parsed out of simple_judge's raw_result JSON. */
export interface JudgeVerdict {
  score?: number;
  explanation?: string;
  dimensions?: Record<string, number>;
  policy_violation?: boolean;
}

/** Parse the judge's raw_result (tolerates fences/prose around the JSON). */
export function parseVerdict(raw: unknown): JudgeVerdict {
  if (typeof raw !== "string") return {};
  return (extractJson(raw) as JudgeVerdict | undefined) ?? {};
}
