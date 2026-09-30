/**
 * Trigger detection, authorization and task extraction.
 *
 * Everything that decides *whether* to run the agent, and *what* to ask
 * it, lives here so the rules can be tested directly instead of being
 * scattered through workflow YAML expressions.
 *
 * Security model
 * --------------
 * The agent can push code and open pull requests, so three gates must all
 * pass before it runs:
 *
 *   1. the acting user must be the repository owner; anyone else is ignored
 *   2. a new issue must carry the `[OpenCode]` title prefix
 *   3. a follow-up comment must start with a recognised command
 *
 * Comment and issue bodies are treated as untrusted text. They are never
 * interpolated into a shell command, and they reach the model only as data
 * inside an explicit delimiter.
 */

import path from 'node:path';

/** The opt-in prefix for a new issue. */
export const ISSUE_TITLE_PREFIX = '[OpenCode]';

/**
 * Commands that continue work on an existing task.
 *
 * `/opencode` is the long form and `/oc` the short one. Both are anchored:
 * a command must be the first non-whitespace text in the comment, so an
 * unrelated comment that merely mentions "oc" or contains the word
 * "opencode" mid-sentence cannot trigger the agent.
 */
export const CONTINUE_COMMANDS = ['/opencode', '/oc'];

/** Bounds on how much untrusted text is handed to the model. */
export const MAX_TASK_CHARACTERS = 8000;
export const MAX_INSTRUCTION_CHARACTERS = 4000;
export const MAX_CONTEXT_COMMENTS = 5;
export const MAX_COMMENT_CHARACTERS = 1500;
export const MAX_ISSUE_TITLE_CHARACTERS = 300;

export const TRIGGER_ISSUE = 'issue';
export const TRIGGER_CONTINUE = 'continue';
export const TRIGGER_DISPATCH = 'dispatch';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Distinct exit code so the workflow can short-circuit without failing. */
export const EXIT_IGNORED = 78;

/** Paths the agent must not push to, under any circumstance. */
export const PROTECTED_BRANCHES = ['main'];

export class TriggerRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TriggerRejected';
    this.reason = reason;
  }
}

export class Trigger {
  constructor({
    kind,
    task,
    instruction = '',
    issueNumber = null,
    issueTitle = '',
    actor = '',
    priorContext = '',
    baseBranch = 'main',
  }) {
    this.kind = kind;
    this.task = task;
    this.instruction = instruction;
    this.issueNumber = issueNumber;
    this.issueTitle = issueTitle;
    this.actor = actor;
    this.priorContext = priorContext;
    this.baseBranch = baseBranch;
  }

  get isIssueDriven() {
    return this.issueNumber !== null;
  }

  /** A single line safe to print in logs and job summaries. */
  get summary() {
    const condensed = String(this.task || this.instruction || '')
      .split(/\s+/)
      .filter(Boolean)
      .join(' ');

    if (!condensed) return '(no task text)';
    if (condensed.length > 200) return `${condensed.slice(0, 197)}...`;
    return condensed;
  }

  toJSON() {
    return {
      kind: this.kind,
      task: this.task,
      instruction: this.instruction,
      issue_number: this.issueNumber,
      issue_title: this.issueTitle,
      actor: this.actor,
      prior_context: this.priorContext,
      base_branch: this.baseBranch,
      summary: this.summary,
    };
  }
}

/**
 * Only the repository owner may start the agent.
 *
 * Comparison is case-insensitive because GitHub logins are, and a missing
 * value on either side is a denial rather than an accidental match.
 */
export function isAuthorizedActor(actor, owner) {
  if (!actor || !owner) return false;
  return String(actor).trim().toLowerCase() === String(owner).trim().toLowerCase();
}

export function hasAgentTitlePrefix(title) {
  if (!title) return false;
  return String(title).trim().startsWith(ISSUE_TITLE_PREFIX);
}

export function stripTitlePrefix(title) {
  if (!title) return '';
  const stripped = String(title).trim();
  if (stripped.startsWith(ISSUE_TITLE_PREFIX)) {
    return stripped.slice(ISSUE_TITLE_PREFIX.length).trim();
  }
  return stripped;
}

/**
 * Parse a follow-up comment.
 *
 * Returns `{ command, instruction }` when the comment starts with a supported
 * command, otherwise null. A bare command with no instruction is valid and
 * means "continue the current task".
 */
export function parseContinuationCommand(body) {
  if (!body) return null;

  const text = String(body).trimStart();

  for (const command of CONTINUE_COMMANDS) {
    if (text === command) return { command, instruction: '' };
    if (text.startsWith(`${command} `) || text.startsWith(`${command}\t`)) {
      return { command, instruction: text.slice(command.length).trim() };
    }
    // A newline directly after the command means the instruction is on the
    // following lines, which is the common way to write a follow-up.
    if (text.startsWith(`${command}\n`)) {
      return { command, instruction: text.slice(command.length).trim() };
    }
  }

  return null;
}

/**
 * Build the initial task from an issue.
 *
 * The title supplies the headline and the body the detail. When the body adds
 * nothing beyond the title, the title alone is used, so the model is never
 * handed a duplicated instruction.
 */
export function extractTaskFromIssue(title, body) {
  const headline = stripTitlePrefix(title);
  const details = String(body || '').trim();

  if (!details) return truncate(headline, MAX_TASK_CHARACTERS);

  if (details.toLowerCase() === headline.toLowerCase()) {
    return truncate(headline, MAX_TASK_CHARACTERS);
  }

  return truncate(`${headline}\n\n${details}`, MAX_TASK_CHARACTERS);
}

/** Validate an `issues: opened` event. */
export function authorizeIssueEvent({ actor, owner, title, body, issueNumber, baseBranch }) {
  if (!isAuthorizedActor(actor, owner)) {
    throw new TriggerRejected(`actor "${actor}" is not the repository owner`);
  }

  if (!hasAgentTitlePrefix(title)) {
    throw new TriggerRejected(`issue title must start with ${ISSUE_TITLE_PREFIX}`);
  }

  const task = extractTaskFromIssue(title, body);

  if (!task.trim()) {
    throw new TriggerRejected('issue contains no task text');
  }

  return new Trigger({
    kind: TRIGGER_ISSUE,
    task,
    issueNumber,
    issueTitle: stripTitlePrefix(title),
    actor: String(actor || ''),
    baseBranch: baseBranch || 'main',
  });
}

/**
 * Validate an `issue_comment: created` event.
 *
 * Unrelated comments raise, and the workflow short-circuits without ever
 * starting the agent.
 */
export function authorizeCommentEvent({
  actor,
  owner,
  body,
  issueNumber,
  originalTask = '',
  issueTitle = '',
  priorComments = [],
  baseBranch,
}) {
  if (!isAuthorizedActor(actor, owner)) {
    throw new TriggerRejected(`actor "${actor}" is not the repository owner`);
  }

  const parsed = parseContinuationCommand(body);

  if (!parsed) {
    throw new TriggerRejected(
      `comment does not start with a supported command: ${CONTINUE_COMMANDS.join(', ')}`
    );
  }

  return new Trigger({
    kind: TRIGGER_CONTINUE,
    task: truncate(originalTask, MAX_TASK_CHARACTERS),
    instruction: truncate(parsed.instruction, MAX_INSTRUCTION_CHARACTERS),
    issueNumber,
    issueTitle: stripTitlePrefix(issueTitle),
    actor: String(actor || ''),
    priorContext: buildPriorContext(priorComments),
    baseBranch: baseBranch || 'main',
  });
}

/** Validate a `workflow_dispatch` event. */
export function authorizeDispatchEvent({ actor, owner, task, issueNumber = null, baseBranch }) {
  if (!isAuthorizedActor(actor, owner)) {
    throw new TriggerRejected(`actor "${actor}" is not the repository owner`);
  }

  const text = String(task || '').trim();

  if (!text) {
    throw new TriggerRejected('dispatch provided no task text');
  }

  return new Trigger({
    kind: TRIGGER_DISPATCH,
    task: truncate(text, MAX_TASK_CHARACTERS),
    issueNumber,
    actor: String(actor || ''),
    baseBranch: baseBranch || 'main',
  });
}

/**
 * Select recent issue comments for continuation context.
 *
 * The full history is never passed in. Only the newest few comments are
 * included, each length-capped, because unbounded history fills the context
 * without adding signal.
 */
export function buildPriorContext(comments) {
  if (!Array.isArray(comments) || !comments.length) return '';

  const recent = comments.filter((comment) => String(comment || '').trim());
  if (!recent.length) return '';

  return recent
    .slice(-MAX_CONTEXT_COMMENTS)
    .map(
      (comment, index) =>
        `[comment ${index + 1}]\n${truncate(String(comment).trim(), MAX_COMMENT_CHARACTERS)}`
    )
    .join('\n\n');
}

/** Bound a length, marking the cut so the model knows it happened. */
export function truncate(text, limit) {
  const cleaned = String(text || '').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}\n\n[truncated by the control plane]`;
}

/**
 * Derive the branch the agent must work on.
 *
 * The base branch is never itself a working branch. Naming is
 * deterministic so a continuation resumes the same branch instead of
 * creating a second one.
 */
export function deriveAgentBranch(baseBranch, issueNumber, attempt = 1) {
  const safeBase = String(baseBranch || 'main').replace(/[^A-Za-z0-9._-]/g, '-');
  const safeNumber = Number.isFinite(issueNumber) ? String(issueNumber) : 'dispatch';
  const suffix = attempt > 1 ? `-a${attempt}` : '';
  return `agent/issue-${safeBase}-${safeNumber}${suffix}`;
}

/** Whether a branch name is one the agent is forbidden to commit onto. */
export function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.includes(String(branch || '').trim());
}

/** Derive the pull-request title for a trigger. */
export function derivePullRequestTitle(trigger) {
  const base = trigger.issueTitle || trigger.task.split('\n')[0] || 'Automated change';
  const condensed = String(base).split(/\s+/).filter(Boolean).join(' ').slice(0, 80);
  return `[OpenCode] ${condensed}`;
}

/** Repository root, resolved once for callers that need it. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
