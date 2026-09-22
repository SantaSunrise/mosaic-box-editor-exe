import assert from "node:assert/strict";
import test from "node:test";
import { pendingExports, runBatch } from "../src/batch-export.ts";

test("only saved, unexported clips enter the batch, including legacy rectangles", () => {
  const entries = [
    { exported: false, box: null },
    { exported: false, box: { mask: [{}] } },
    { exported: true, stale: true, box: { mask: [{}] } },
    { exported: false, box: { box: [0, 0, 1, 1] } },
    { exported: false, box: { mask: [] } },
  ];
  assert.deepEqual(pendingExports(entries), [entries[1], entries[3]]);
});
test("runs sequentially and continues after a failure", async () => {
  let active = 0;
  const order = [];
  const report = await runBatch([1, 2, 3], {
    cancelled: () => false,
    progress: () => {},
    exportItem: async (item) => {
      assert.equal(active++, 0);
      order.push(item);
      await Promise.resolve();
      active--;
      if (item === 2) throw Error("failed");
    },
  });
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(report.completed, [1, 3]);
  assert.equal(report.failed[0].item, 2);
  assert.equal(report.remaining, 0);
});
test("cancel completes the current clip and leaves the rest untouched", async () => {
  let cancelled = false;
  const order = [];
  const report = await runBatch([1, 2, 3], {
    cancelled: () => cancelled,
    progress: () => {},
    exportItem: async (item) => {
      order.push(item);
      cancelled = true;
    },
  });
  assert.deepEqual(order, [1]);
  assert.equal(report.remaining, 2);
});
