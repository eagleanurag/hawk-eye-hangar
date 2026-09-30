/**
 * Issue and job-summary reporting.
 *
 * One report per task, written once at the end. Reports are structured,
 * bounded and redacted so they stay readable on a phone and cannot leak a
 * credential into a durable, widely readable place.
 */

import { redact, truncateForComment } from './redaction.mjs';
import {
  STATUS_DIRTY_NO_COMMIT,
  STATUS_FAILED,
  STATUS_NO_CHANGES,
  STATUS_NO_PR,
  STATUS_PUSH_FAILED,
  STATUS_PUSH_UNVERIFIED,
  STATUS_SUCCESS,
} from './verdict.mjs';

// Re-exported so a consumer can render a report without importing two modules.
export { STATUS_DIRTY_NO_COMMIT, STATUS_FAILED, STATUS_NO_CHANGES, STATUS_NO_PR, STATUS_PUSH_FAILED, STATUS_PUSH_UNVERIFIED, STATUS_SUCCESS };

/** Report-only statuses, owned here. */
export const STATUS_BLOCKED = 'BLOCKED';
export const STATUS_BLOCKED_BUDGET = 'BLOCKED_AFTER_3_ATTEMPTS';

/** Every status a task may end in, for validation and rendering. */
export const TASK_STATUSES = new Set([
  STATUS_SUCCESS,
  STATUS_NO_CHANGES,
  STATUS_DIRTY_NO_COMMIT,
  STATUS_PUSH_FAILED,
  STATUS_PUSH_UNVERIFIED,
  STATUS_NO_PR,
  STATUS_FAILED,
  STATUS_BLOCKED,
  STATUS_BLOCKED_BUDGET,
]);

export const MAX_COMMENT_CHARACTERS = 6000;

export class TaskOutcome {
  constructor({
    status,
    reason = '',
    commitSha = '',
    branch = '',
    pullRequest = '',
    pullRequestUrl = '',
    tests = 'not recorded',
    checkRuns = '',
    ciResult = 'not run',
    recoveryAttempts = 0,
    maxAttempts = 3,
    filesChanged = 'none recorded',
    summary = '',
    humanAction = 'none',
    failureEvidence = '',
  }) {
    this.status = status;
    this.reason = reason;
    this.commitSha = commitSha;
    this.branch = branch;
    this.pullRequest = pullRequest;
    this.pullRequestUrl = pullRequestUrl;
    this.tests = tests;
    this.checkRuns = checkRuns;
    this.ciResult = ciResult;
    this.recoveryAttempts = recoveryAttempts;
    this.maxAttempts = maxAttempts;
    this.filesChanged = filesChanged;
    this.summary = summary;
    this.humanAction = humanAction;
    this.failureEvidence = failureEvidence;
  }

  get isSuccess() {
    return this.status === STATUS_SUCCESS || this.status === STATUS_NO_CHANGES;
  }
}

export class ReportContext {
  constructor({ trigger, outcome, secrets = [], workflowRunUrl = '', extraNotes = [] }) {
    this.trigger = trigger;
    this.outcome = outcome;
    this.secrets = secrets;
    this.workflowRunUrl = workflowRunUrl;
    this.extraNotes = extraNotes;
  }
}

function block(value) {
  const cleaned = String(value || '').trim();
  if (!cleaned) return '_(none)_';
  if (cleaned.includes('\n')) return codeBlock(cleaned);
  return cleaned;
}

function codeBlock(value) {
  // A longer fence than any backtick run inside the value, so the block
  // cannot be terminated early by its own content.
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}

/** Render the structured issue report. Every field is redacted first. */
export function buildReport(context) {
  const { trigger, outcome, secrets } = context;

  const clean = (value, empty = 'not recorded') => {
    const text = redact(String(value || '').trim(), { secrets });
    return text || empty;
  };

  const lines = ['## OpenCode Task Report', '', `Status: ${clean(outcome.status, STATUS_FAILED)}`, ''];

  if (outcome.reason) {
    lines.push('Why:', block(clean(outcome.reason, '')), '');
  }

  lines.push('Task:', block(trigger.summary), '');

  lines.push('Branch:', block(clean(outcome.branch, 'none')), '');

  lines.push('PR:', outcome.pullRequestUrl
    ? `[${clean(outcome.pullRequest, outcome.pullRequestUrl)}](${redact(outcome.pullRequestUrl, { secrets })})`
    : block(clean(outcome.pullRequest, 'none')), '');

  lines.push(
    'Commit(s):',
    block(clean(outcome.commitSha, 'none')),
    '',
    'Tests:',
    block(clean(outcome.tests, 'not recorded')),
    '',
    'Build / QA:',
    block(clean(outcome.checkRuns, 'not recorded')),
    '',
    'CI run:',
    block(clean(outcome.ciResult, 'not run')),
    '',
    'Recovery attempts:',
    `${outcome.recoveryAttempts}/${outcome.maxAttempts}`,
    '',
    'Files changed:',
    block(clean(outcome.filesChanged, 'none recorded')),
    '',
    'Final result:',
    block(clean(outcome.summary, 'no summary produced')),
    ''
  );

  if (outcome.failureEvidence) {
    lines.push(
      'Failure evidence:',
      codeBlock(truncateForComment(redact(outcome.failureEvidence, { secrets }), MAX_COMMENT_CHARACTERS / 2)),
      ''
    );
  }

  for (const note of context.extraNotes) {
    const cleaned = redact(String(note), { secrets });
    if (cleaned.trim()) lines.push(cleaned.trim(), '');
  }

  if (context.workflowRunUrl) {
    lines.push(`Full logs and artifacts: ${redact(context.workflowRunUrl, { secrets })}`, '');
  }

  lines.push('Human action required:', block(clean(outcome.humanAction, 'none')), '');

  return truncateForComment(redact(lines.join('\n'), { secrets }), MAX_COMMENT_CHARACTERS);
}

/** Render the GitHub Actions job summary for this task. */
export function buildJobSummary(context) {
  const { trigger, outcome, secrets } = context;
  const r = (value) => redact(String(value || ''), { secrets });

  const rows = [
    ['Status', r(outcome.status)],
    ['Why', r(outcome.reason || 'not recorded')],
    ['Entry mode', r(trigger.kind)],
    ['Issue', r(trigger.issueNumber ?? 'n/a')],
    ['Branch', r(outcome.branch || 'none')],
    ['PR', r(outcome.pullRequestUrl || outcome.pullRequest || 'none')],
    ['Commit', r(outcome.commitSha || 'none')],
    ['CI result', r(outcome.ciResult)],
    ['Recovery attempts', `${outcome.recoveryAttempts}/${outcome.maxAttempts}`],
    ['Tests', r(outcome.tests)],
    ['Human action', r(outcome.humanAction || 'none')],
  ];

  const lines = ['## OpenCode Task Report', ''];
  for (const [label, value] of rows) lines.push(`- **${label}:** ${value}`);
  lines.push('');

  const summary = r(outcome.summary).trim();
  if (summary) lines.push('### Result', '', summary, '');

  const files = r(outcome.filesChanged).trim();
  if (files) lines.push('### Files changed', '', files, '');

  if (context.workflowRunUrl) {
    lines.push(`[Full logs and artifacts](${redact(context.workflowRunUrl, { secrets })})`, '');
  }

  return lines.join('\n');
}
