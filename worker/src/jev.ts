// Build Jev inputs for one frame and turn its answers into detection boxes.
//
// Jev answers typed questions about a `state`. Image input (`assets`) and the
// `box` question type are experimental in jev-1.14 and need the
// `TypeSafe-Danger-Zone-Images: true` header. A box question returns a single
// box, so each category yields at most one region per frame.

export type Category = {
  id: string;
  label: string;
  /** Yes/no question: is an unmosaicked region of this kind visible? */
  present: string;
  /** Box question: where is it? */
  locate: string;
};

export const CATEGORIES: Category[] = [
  {
    id: "genitals",
    label: "性器",
    present:
      "Does `frame` show human genitals or an anus that are visible without censoring? Answer no if they are covered by mosaic, pixelation, blur, a black bar, clothing or anything else.",
    locate:
      "the uncensored human genitals or anus in `frame` that would need a mosaic",
  },
];

export type Frame = { id: string; mime: string; data: string };
export type Detection = {
  label: string;
  score: number;
  box: [number, number, number, number];
  boxConfidence?: number;
};

const FORMATS: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
};
export const isSupportedMime = (mime: string) => mime in FORMATS;

export function buildJevInput(frame: Frame, categories = CATEGORIES) {
  const asset = `frame-${frame.id}`;
  const questions: Record<string, { type: string; instructions: string }> = {};
  for (const category of categories) {
    questions[`${category.id}_present`] = {
      type: "noul",
      instructions: category.present,
    };
    questions[`${category.id}_box`] = {
      type: "box",
      instructions: category.locate,
    };
  }
  return {
    // Jev rejects an asset that `state` never mentions.
    state: { frame: asset },
    assets: {
      [asset]: {
        type: "image",
        format: FORMATS[frame.mime],
        data_base64: frame.data,
      },
    },
    questions,
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Detections whose yes/no probability reaches `threshold`. A positive answer
 * without a usable box still counts and covers the whole frame, so a broken
 * box never turns an NG frame into OK.
 */
export function parseJevAnswers(
  output: unknown,
  threshold: number,
  categories = CATEGORIES,
): Detection[] {
  const answers = (output as { answers?: Record<string, any> })?.answers;
  if (!answers || typeof answers !== "object")
    throw new Error("Jev response has no answers");
  const detections: Detection[] = [];
  for (const category of categories) {
    const present = answers[`${category.id}_present`];
    const probability = present?.noul;
    if (!finite(probability))
      throw new Error(`Jev response has no answer for ${category.id}`);
    if (probability < threshold) continue;
    const answer = answers[`${category.id}_box`];
    const edges = answer?.box;
    let box: Detection["box"] = [0, 0, 1, 1];
    if (
      edges &&
      [edges.left, edges.top, edges.right, edges.bottom].every(finite)
    ) {
      const x0 = clamp01(Math.min(edges.left, edges.right)),
        x1 = clamp01(Math.max(edges.left, edges.right)),
        y0 = clamp01(Math.min(edges.top, edges.bottom)),
        y1 = clamp01(Math.max(edges.top, edges.bottom));
      if (x1 > x0 && y1 > y0) box = [x0, y0, x1, y1];
    }
    detections.push({
      label: category.label,
      score: probability,
      box,
      ...(finite(answer?.confidence)
        ? { boxConfidence: answer.confidence }
        : {}),
    });
  }
  return detections;
}

export function inputTokens(output: unknown): number {
  const value = (output as { usage?: { input_tokens?: unknown } })?.usage
    ?.input_tokens;
  return finite(value) ? value : 0;
}
