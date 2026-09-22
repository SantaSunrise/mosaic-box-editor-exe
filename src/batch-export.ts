export type BatchReport<T> = {
  completed: T[];
  failed: { item: T; error: string }[];
  remaining: number;
};

// One encoder at a time; a failure doesn't prevent unrelated clips from exporting.
export async function runBatch<T>(
  items: T[],
  options: {
    exportItem: (item: T) => Promise<unknown>;
    cancelled: () => boolean;
    progress: (done: number, total: number, current: T | null) => void;
  },
): Promise<BatchReport<T>> {
  const report: BatchReport<T> = {
    completed: [],
    failed: [],
    remaining: items.length,
  };
  for (const item of items) {
    if (options.cancelled()) break;
    options.progress(items.length - report.remaining, items.length, item);
    try {
      await options.exportItem(item);
      report.completed.push(item);
    } catch (error) {
      report.failed.push({ item, error: String(error) });
    }
    report.remaining--;
    options.progress(items.length - report.remaining, items.length, null);
  }
  return report;
}

export function pendingExports<
  T extends {
    exported: boolean;
    box: { mask?: unknown[]; box?: number[] } | null;
  },
>(entries: T[]): T[] {
  return entries.filter(
    (entry) =>
      !entry.exported &&
      Boolean(entry.box?.mask?.length || entry.box?.box?.length === 4),
  );
}
