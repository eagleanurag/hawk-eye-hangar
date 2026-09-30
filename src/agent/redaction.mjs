/**
 * Credential shapes that must be redacted before anything reaches an issue
 * comment, a job summary or an artifact.
 *
 * Why the patterns look the way they do
 * -------------------------------------
 * Each entry pairs a shape with a human-readable name, so a pattern can be
 * changed deliberately and reviewed as a change to detection coverage rather
 * than as an anonymous tweak to a regular expression.
 *
 * Ordering is significant. Specific shapes come before the broad
 * `name = value` rule, because that rule will otherwise consume the prefix of
 * a more specific match and leave a mangled remainder behind.
 */

export const REDACTED = '[REDACTED]';

/**
 * GitHub tokens. One pattern covers every documented prefix: ghp_ (personal),
 * gho_ (OAuth), ghu_ (user-to-server), ghs_ (server-to-server), ghr_
 * (refresh) and the fine-grained github_pat_ form.
 */
export const GITHUB_TOKEN = /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Slack, Stripe and OpenAI style prefixed keys. */
export const PREFIXED_KEY = /\b(?:sk|pk|rk|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g;

/** AWS access key identifiers. */
export const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

/**
 * Google API keys. The documented length is 35; a range is matched so a
 * slightly different length is still caught rather than slipping through.
 */
export const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{30,45}\b/g;

/**
 * Bearer tokens. Checked before the assignment rule, because
 * `Authorization: Bearer <token>` must lose the token and not merely the word
 * "Bearer".
 */
export const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** A PEM private key block, matched whole. */
export const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Generic `key=value` / `"key": "value"` assignments whose key name looks
 * secret. Deliberately last: it is the broadest rule. The negative lookahead
 * stops an earlier substitution from being re-matched and leaving a stray
 * bracket behind.
 */
export const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_]*)(\s*[:=]\s*)(?!\[REDACTED\])("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;}\]]{4,})/gi;

/** Ordered rules. The assignment rule is last on purpose. */
export const PATTERNS = [
  GITHUB_TOKEN,
  PREFIXED_KEY,
  AWS_ACCESS_KEY,
  GOOGLE_API_KEY,
  BEARER_TOKEN,
  PEM_BLOCK,
  SECRET_ASSIGNMENT,
];

/** The rule that preserves its key so a reader still knows what was hidden. */
const ASSIGNMENT_RULE = SECRET_ASSIGNMENT;

/**
 * Remove credential-shaped content from text.
 *
 * Known secret values are replaced literally first, because they may not match
 * any shape-based pattern. Longest values are replaced first so a short secret
 * cannot partially mask a longer one.
 */
export function redact(text, { secrets = [] } = {}) {
  if (!text) return '';

  let result = String(text);

  const known = [...new Set(secrets.filter((value) => value && String(value).length >= 8))].sort(
    (a, b) => String(b).length - String(a).length
  );

  for (const secret of known) {
    result = result.split(secret).join(REDACTED);
  }

  for (const pattern of PATTERNS) {
    if (pattern === ASSIGNMENT_RULE) {
      result = result.replace(pattern, (_match, key, separator) => `${key}${separator}${REDACTED}`);
    } else {
      result = result.replace(pattern, REDACTED);
    }
  }

  return result;
}

/**
 * Bound text destined for a public comment.
 *
 * Keeps the head and the tail, because the tail of a failure log is usually
 * where the actual error is. The middle is what gets cut.
 */
export function truncateForComment(text, limit = 6000) {
  const cleaned = String(text || '').trim();
  if (cleaned.length <= limit) return cleaned;

  const head = Math.floor(limit / 3);
  const tail = limit - head - 40;
  const omitted = cleaned.length - head - tail;

  return `${cleaned.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${cleaned.slice(-tail)}`;
}

/**
 * Collect environment values that must never be echoed.
 *
 * Only names that look secret are considered, and only from the environment.
 * Nothing is written to disk.
 */
export function knownSecrets(env = process.env) {
  const markers = ['token', 'secret', 'password', 'api_key', 'key'];
  const values = [];

  for (const [name, value] of Object.entries(env || {})) {
    const lowered = name.toLowerCase();
    if (!markers.some((marker) => lowered.includes(marker))) continue;
    if (value && String(value).length >= 8) values.push(String(value));
  }

  return values;
}