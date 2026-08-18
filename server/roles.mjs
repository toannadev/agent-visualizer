// Role comes from an explicit assignment, never from ticket/title text.
// Sources, in order:
//   1. User picker / chat directive ("@reviewer grok …")
//   2. HOD 0.1.18 pane token hod_role
//   3. Herdr agent name from `herdr agent start <name>` (Desktop 0.1.7)

export const HOD_ROLE_VALUES = Object.freeze([
  "controller",
  "worker",
  "advisor",
  "reviewer",
  "tester",
]);

export const HOD_RELATION_VALUES = Object.freeze(["delegate", "consult", "verify"]);

export const HOD_ROLE_RELATIONS = Object.freeze({
  controller: null,
  worker: "delegate",
  advisor: "consult",
  reviewer: "verify",
  tester: "verify",
});

const ROLES = {
  lead: { id: "lead", label: "Lead", family: "lead", badge: "Lead" },
  worker: { id: "worker", label: "Worker", family: "work", badge: "Worker" },
  impl: { id: "impl", label: "Impl", family: "work", badge: "Impl" },
  review: { id: "review", label: "Reviewer", family: "verify", badge: "Reviewer" },
  advisor: { id: "advisor", label: "Advisor", family: "consult", badge: "Advisor" },
  tester: { id: "tester", label: "Tester", family: "verify", badge: "Tester" },
  unknown: { id: "unknown", label: "Unmapped", family: "work", badge: "" },
};

const HOD_TO_ROLE = {
  controller: "lead",
  worker: "worker",
  advisor: "advisor",
  reviewer: "review",
  tester: "tester",
};

// Whole name segments from `herdr agent start <name>` or settings.<role>.json.
const NAME_TO_ROLE = {
  controller: "lead",
  lead: "lead",
  impl: "impl",
  implementer: "impl",
  reviewer: "review",
  worker: "worker",
  advisor: "advisor",
  tester: "tester",
};

export const ASSIGNABLE_ROLES = Object.freeze([
  "lead", "worker", "impl", "review", "advisor", "tester",
]);

const WHO_ALIAS = {
  gpt: "codex",
  openai: "codex",
  chatgpt: "codex",
  sonnet: "claude",
  opus: "claude",
  haiku: "claude",
  gemini: "other",
};

function roleInfo(id) {
  return ROLES[id] || ROLES.unknown;
}

export function roleLabel(id) {
  return roleInfo(id).label;
}

export function parseHodRole(raw) {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return HOD_ROLE_VALUES.includes(key) ? key : null;
}

export function parseHodRelation(raw) {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return HOD_RELATION_VALUES.includes(key) ? key : null;
}

export function canonicalizeRole(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === "unmapped") return "unknown";
  if (HOD_TO_ROLE[key]) return HOD_TO_ROLE[key];
  if (ASSIGNABLE_ROLES.includes(key) || key === "unknown") return key;
  return NAME_TO_ROLE[key] || null;
}

/** Role the user chose when they started the agent (`herdr agent start impl`). */
export function roleFromAgentName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  if (NAME_TO_ROLE[trimmed]) return NAME_TO_ROLE[trimmed];
  const parts = trimmed.split(/[-_]+/).filter(Boolean);
  for (const part of parts) {
    if (NAME_TO_ROLE[part]) return NAME_TO_ROLE[part];
  }
  return null;
}

/** Role from `--settings .claude/settings.impl.json` if the start argv is visible. */
export function roleFromSettingsPath(path) {
  if (typeof path !== "string") return null;
  const m = path.trim().toLowerCase().match(/settings\.([a-z0-9_-]+)\.json$/);
  return m ? canonicalizeRole(m[1]) : null;
}

export function resolveRole({ kind, hodRole, override, name, settingsPath } = {}) {
  const user = canonicalizeRole(override);
  if (user) return { role: user, roleSource: "user" };
  const hod = canonicalizeRole(hodRole);
  if (hod) return { role: hod, roleSource: "hod" };
  const fromSettings = roleFromSettingsPath(settingsPath);
  if (fromSettings) return { role: fromSettings, roleSource: "name" };
  const fromName = roleFromAgentName(name);
  if (fromName) return { role: fromName, roleSource: "name" };
  if (kind === "lead") return { role: "lead", roleSource: "lead" };
  return { role: "unknown", roleSource: "unmapped" };
}

function normalizeWho(who) {
  const key = String(who || "").toLowerCase();
  return WHO_ALIAS[key] || key;
}

const ROLE_WORD = "worker|advisor|reviewer|review|tester|lead|controller|impl|implementer";
const SLASH_ALIAS = {
  reviewer: "review",
  review: "review",
  controller: "lead",
  lead: "lead",
  impl: "impl",
  implementer: "impl",
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

/** Parse an explicit user role assignment. Not used to guess roles from ordinary prompts. */
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
