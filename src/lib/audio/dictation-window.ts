export const DICTATION_WINDOW_MS = 8_000;

/** Close short windows; the recorder independently rejects silence/noise before sending. */
export function shouldFlushDictation(totalMs: number, speechMs: number, silenceMs: number, windowMs = DICTATION_WINDOW_MS) {
  return totalMs >= windowMs || (speechMs >= 600 && totalMs >= 2_000 && silenceMs >= 1_000);
}
