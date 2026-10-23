import { createHash } from "node:crypto";

export function canonicalDigest(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => {
            if (a < b) return -1;
            return Number(a > b);
          })
          .map(([k, v]) => [k, sort(v)]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(sort(JSON.parse(JSON.stringify(value)))))
    .digest("hex");
}

// Receipts refer to their containing record; exclude only that receipt table.
export function nativeRecordDigest(record: { pluginBindingProofs?: unknown }): string {
  const { pluginBindingProofs: _proofs, ...data } = record;
  return canonicalDigest(data);
}
