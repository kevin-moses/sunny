export const MAX_BODY_CHARS = 20_000;

const BREAKS = ["\n\n", "\n", " "];

export interface ShownBody {
  text: string;
  cutNote: string | null;
}

function cutAtBreak(text: string): string {
  const head = text.slice(0, MAX_BODY_CHARS + 1);
  for (const separator of BREAKS) {
    const at = head.lastIndexOf(separator);
    if (at > MAX_BODY_CHARS / 2) return text.slice(0, at).trimEnd();
  }
  return text.slice(0, MAX_BODY_CHARS);
}

export function shownBody(text: string): ShownBody {
  if (text.length <= MAX_BODY_CHARS) return { text, cutNote: null };
  return {
    text: cutAtBreak(text),
    cutNote: `The body was cut after ${MAX_BODY_CHARS} characters; the rest is not shown.`,
  };
}
