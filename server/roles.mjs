// Canonical office roles. Herdr hod_role maps in; title/tool heuristics fill gaps.

const ROLES = {
  lead: { id: "lead", label: "Lead", family: "lead", badge: "Lead" },
  worker: { id: "worker", label: "Worker", family: "work", badge: "Worker" },
  explore: { id: "explore", label: "Explore", family: "work", badge: "Explore" },
  implement: { id: "implement", label: "Coder", family: "work", badge: "Coder" },
  review: { id: "review", label: "Review", family: "verify", badge: "Review" },
  advisor: { id: "advisor", label: "Advisor", family: "consult", badge: "Advisor" },
  tester: { id: "tester", label: "Tester", family: "verify", badge: "Tester" },
  unknown: { id: "unknown", label: "Agent", family: "work", badge: "" },
};

const HOD_TO_ROLE = {
  controller: "lead",
  worker: "worker",
  advisor: "advisor",
  reviewer: "review",
  tester: "tester",
};

const ADVISOR_RE = /\b(advisor|advis[eo]r|cố vấn|co van|consult|thiết kế|thiet ke|architect)\b/i;
const REVIEW_RE = /\b(review|reviewer|diff|check|audit|inspect|soát|soat)\b/i;
const TESTER_RE = /\b(test|tester|qa|verify|e2e|spec)\b/i;
const EXPLORE_RE = /\b(explore|search|find|look|where|locate|scan|scout)\b/i;
const IMPLEMENT_RE = /\b(implement|patch|fix|write|coder|build|sửa|sua)\b/i;


function roleInfo(id) {
  return ROLES[id] || ROLES.unknown;
}

export function roleLabel(id) {
  return roleInfo(id).label;
}

export const ASSIGNABLE_ROLES = ["lead", "worker", "explore", "implement", "review", "advisor", "tester"];

const WHO_ALIAS = {
  gpt: "codex",
  openai: "codex",
  chatgpt: "codex",
  sonnet: "claude",
  opus: "claude",
  haiku: "claude",
  gemini: "other",
};

function normalizeWho(who) {
  const key = String(who || "").toLowerCase();
  return WHO_ALIAS[key] || key;
}

export function canonicalizeRole(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === "controller") return "lead";
  if (key === "reviewer") return "review";
  if (key === "coder") return "implement";
  if (ASSIGNABLE_ROLES.includes(key) || key === "unknown") return key;
  return normalizeHodRole(key);
}

const ROLE_WORD = "worker|advisor|reviewer|review|tester|explore|coder|implement|lead";
const SLASH_ALIAS = {
  reviewer: "review",
  review: "review",
  coder: "implement",
  implement: "implement",
};

const DIRECTIVE_PATTERNS = [
  new RegExp(`^\\/(${ROLE_WORD})\\s+(\\S+)(?:\\s+([\\s\\S]+))?$`, "i"),
  new RegExp(`^@(${ROLE_WORD})\\s+(\\S+)(?:\\s+([\\s\\S]+))?$`, "i"),
  new RegExp(`^role\\s*:\\s*(${ROLE_WORD})\\s+(\\S+)(?:\\s+([\\s\\S]+))?$`, "i"),
  new RegExp(`^(?:với\\s+)?vai\\s+trò\\s+(${ROLE_WORD})[,:]?\\s+(\\S+)(?:\\s*[:–-]\\s*|\\s+)([\\s\\S]+)$`, "i"),
  new RegExp(`^as\\s+(${ROLE_WORD})[,:]?\\s+(\\S+)(?:\\s*[:–-]\\s*|\\s+)([\\s\\S]+)$`, "i"),
];

const WHO_FIRST_PATTERNS = [
  new RegExp(`^assign\\s+(\\S+)\\s+as\\s+(${ROLE_WORD})\\s*[:–-]?\\s*([\\s\\S]+)$`, "i"),
  new RegExp(`^giao\\s+(\\S+)\\s+(?:với\\s+)?(?:vai\\s+trò\\s+)?(${ROLE_WORD})\\s*[:–-]?\\s*([\\s\\S]+)$`, "i"),
];

function packDirective(alias, who, task) {
  const key = String(alias || "").toLowerCase();
  return {
    role: SLASH_ALIAS[key] || key,
    who: String(who || "").toLowerCase(),
    task: String(task || "").trim(),
    alias: key,
  };
}

/** Parse a user role assignment. Prefer "@worker grok …" or "vai trò worker …" — not "/worker" inside Claude Code. */
export function parseRoleDirective(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  for (const re of DIRECTIVE_PATTERNS) {
    const m = raw.match(re);
    if (m) return packDirective(m[1], m[2], m[3]);
  }
  for (const re of WHO_FIRST_PATTERNS) {
    const m = raw.match(re);
    if (m) return packDirective(m[2], m[1], m[3]);
  }
  return null;
}

export function matchDirective(directives, { runtime, herdrName } = {}) {
  const list = directives || [];
  const rt = String(runtime || "").toLowerCase();
  const name = String(herdrName || "").toLowerCase();
  return list.find((d) => {
    const who = String(d.who || "").toLowerCase();
    if (!who) return false;
    const want = normalizeWho(who);
    if (want === rt) return true;
    if (name && (name === want || name === who || name.startsWith(`${want}-`) || name.includes(want))) return true;
    return false;
  }) || null;
}

function normalizeHodRole(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return HOD_TO_ROLE[key] || (ROLES[key] ? key : null);
}

function inferRoleFromText(...parts) {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return "unknown";
  if (ADVISOR_RE.test(text)) return "advisor";
  if (TESTER_RE.test(text)) return "tester";
  if (REVIEW_RE.test(text)) return "review";
  if (EXPLORE_RE.test(text)) return "explore";
  if (IMPLEMENT_RE.test(text)) return "implement";
  return "unknown";
}

export function resolveRole({ kind, hodRole, title, name } = {}) {
  if (kind === "lead") {
    return { role: "lead", roleSource: hodRole ? "hod" : "lead" };
  }
  const hod = normalizeHodRole(hodRole);
  if (hod) return { role: hod, roleSource: "hod" };
  const fromText = inferRoleFromText(title, name);
  if (fromText !== "unknown") {
    return { role: fromText, roleSource: "inferred" };
  }
  return { role: "unknown", roleSource: "inferred" };
}


