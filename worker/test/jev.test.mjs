import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJevInput,
  IMAGE_FORMATS,
  inputTokens,
  parseJevAnswers,
} from "../src/jev.ts";

const answers = (noul, box, confidence = 0.9) => ({
  model: "jev-1.14.0",
  answers: {
    genitals_present: { type: "noul", noul },
    genitals_box: { type: "box", box, confidence },
  },
  usage: { input_tokens: 756, output_tokens: 39 },
});

test("state references the single image asset", () => {
  const input = buildJevInput({ id: "3", mime: "image/jpeg", data: "AAAA" });
  assert.deepEqual(input.state, { frame: "img-frame-3" });
  assert.deepEqual(input.assets["img-frame-3"], {
    type: "image",
    format: "jpg",
    data_base64: "AAAA",
  });
  assert.equal(input.questions.genitals_present.type, "noul");
  assert.equal(input.questions.genitals_box.type, "box");
  assert.match(
    input.questions.genitals_present.instructions,
    /uncensored genitals/,
  );
});

test("the image format name follows the backend", () => {
  const frame = { id: "0", mime: "image/jpeg", data: "AAAA" };
  assert.equal(
    buildJevInput(frame, IMAGE_FORMATS["workers-ai"]).assets["img-frame-0"]
      .format,
    "jpeg",
  );
  assert.equal(
    buildJevInput({ ...frame, mime: "image/png" }).assets["img-frame-0"].format,
    "png",
  );
});

test("edges become a normalized [x0, y0, x1, y1] box above the threshold", () => {
  const detections = parseJevAnswers(
    answers(0.93, { top: 0.11, bottom: 0.51, left: 0.49, right: 0.83 }),
    0.5,
  );
  assert.deepEqual(detections, [
    {
      label: "性器",
      score: 0.93,
      box: [0.49, 0.11, 0.83, 0.51],
      located: true,
      boxConfidence: 0.9,
    },
  ]);
  assert.equal(inputTokens(answers(0.1, null)), 756);
});

test("below the threshold nothing is reported", () => {
  assert.deepEqual(
    parseJevAnswers(
      answers(0.2, { top: 0, bottom: 1, left: 0, right: 1 }),
      0.5,
    ),
    [],
  );
});

test("a positive answer with a broken box still counts, over the whole frame", () => {
  const [detection] = parseJevAnswers(
    answers(0.8, { top: 0.5, bottom: 0.5, left: "x", right: 1 }),
    0.5,
  );
  assert.deepEqual(detection.box, [0, 0, 1, 1]);
  assert.equal(detection.located, false);
});

test("a missing yes/no answer is an error, not a clean frame", () => {
  assert.throws(() => parseJevAnswers({ answers: {} }, 0.5));
  assert.throws(() => parseJevAnswers({}, 0.5));
});
