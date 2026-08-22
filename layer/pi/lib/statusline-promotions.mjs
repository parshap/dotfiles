const ROLES = new Set(["dim", "accent", "warning", "text", "ctx-ok", "ctx-warn", "ctx-danger"]);

export function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

export function compileStatusPromotions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("promotions must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`promotion ${index} must be an object`);
    if (typeof item.statusKey !== "string" || !item.statusKey) throw new Error(`promotion ${index} requires statusKey`);
    if (typeof item.pattern !== "string" || !item.pattern) throw new Error(`promotion ${index} requires pattern`);
    const captureGroup = item.captureGroup ?? 0;
    if (!Number.isSafeInteger(captureGroup) || captureGroup < 0) throw new Error(`promotion ${index} captureGroup must be a non-negative integer`);
    const defaultRole = item.defaultRole ?? "text";
    if (!ROLES.has(defaultRole)) throw new Error(`promotion ${index} has invalid defaultRole`);
    const roles = item.roles ?? {};
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error(`promotion ${index} roles must be an object`);
    for (const role of Object.values(roles)) if (!ROLES.has(role)) throw new Error(`promotion ${index} has invalid role mapping`);
    return {
      statusKey: item.statusKey,
      regex: new RegExp(item.pattern),
      captureGroup,
      roles,
      defaultRole,
      consume: item.consume !== false,
    };
  });
}

export function selectPromotedStatus(statuses, promotions) {
  for (const promotion of promotions) {
    const raw = statuses.get(promotion.statusKey);
    if (!raw) continue;
    const match = promotion.regex.exec(stripAnsi(raw));
    if (!match) continue;
    const text = match[promotion.captureGroup];
    if (typeof text !== "string" || !text) continue;
    return {
      segment: { text, role: promotion.roles[text] ?? promotion.defaultRole },
      consumedKey: promotion.consume ? promotion.statusKey : undefined,
    };
  }
  return undefined;
}
