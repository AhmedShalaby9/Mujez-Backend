const sensitive =
  /password|passwd|secret|token|authorization|cookie|credential|digest|privatekey|apikey/i;
export function sanitizeAudit(value: unknown, depth = 0): any {
  if (depth > 10) return "[depth limit]";
  if (typeof value === "string")
    return /-----BEGIN .*PRIVATE KEY-----|\bBearer\s+\S+/i.test(value)
      ? "[redacted]"
      : value.slice(0, 5000);
  if (Array.isArray(value))
    return value.slice(0, 500).map((v) => sanitizeAudit(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        sensitive.test(k.replace(/[_-]/g, ""))
          ? "[redacted]"
          : sanitizeAudit(v, depth + 1),
      ]),
    );
  }
  return value;
}
export function severityFor(action: string): "low" | "med" | "high" {
  if (
    /^(platform_user\.|platform_role\.|settings\.)/.test(action) &&
    !action.endsWith("seeded")
  )
    return "high";
  if (/suspend|archiv|refund|credit|override/.test(action)) return "high";
  if (/payment|subscription|workspace|audit\.export/.test(action)) return "med";
  return "low";
}
