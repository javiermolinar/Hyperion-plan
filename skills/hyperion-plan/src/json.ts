/** Python-compatible finite float spelling; JSON numbers retain their int/float kind. */
export function floatJSON(value: number): string {
  if (!Number.isFinite(value))
    throw new Error(
      "Non-finite numeric metadata is unsupported; source was not changed",
    );
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16))
    return value
      .toExponential()
      .replace(
        /e([+-])(\d+)$/,
        (_, sign, digits) => "e" + sign + digits.padStart(2, "0"),
      );
  const text = String(value);
  return Number.isInteger(value) ? text + ".0" : text;
}

/** Opaque numeric metadata. toJSON emits a number, never a tagged object or string. */
export class JsonNumber {
  constructor(readonly token: string) {}
  toJSON(): unknown {
    const raw = (JSON as typeof JSON & { rawJSON?: (text: string) => unknown })
      .rawJSON;
    if (!raw)
      throw new Error(
        "Lossless numeric metadata requires JSON.rawJSON support",
      );
    return raw(this.token);
  }
}

/** Node 22+ and current card hosts supply each primitive's original JSON source. */
export function parseJSON(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      const source = context?.source;
      if (!source)
        throw new Error("Lossless JSON parsing is unavailable in this runtime");
      if (/[.eE]/.test(source)) return new JsonNumber(floatJSON(value));
      if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
      return new JsonNumber(BigInt(source).toString());
    },
  );
}
