#!/usr/bin/env node
/**
 * Render the final task report and deliver it.
 *
 * Posts one comment into the originating issue (or the pull request) when the
 * run was issue-driven, and always writes a job summary plus an artifact.
 *
 *     node src/agent/report.mjs --trigger trigger.json --attempt attempt-1.json \
 *       --out report.md --summary job-summary.md --post
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { Trigger } from './events.mjs';
import { knownSecrets, redact } from './redaction.mjs';
import { STATUS_FAILED, TASK_STATUSES, ReportContext, TaskOutcome, buildJobSummary, buildReport } from './reporting.mjs';

function loadJson(pathname) {
  if (!pathname) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function triggerFromDict(payload) {
  return new Trigger({
    kind: String(payload.kind || 'unknown'),
    task: String(payload.task || ''),
    instruction: String(payload.instruction || ''),
    issueNumber: payload.issue_number ?? null,
    issueTitle: String(payload.issue_title || ''),
    actor: String(payload.actor || ''),
    priorContext: String(payload.prior_context || ''),
    baseBranch: String(payload.base_branch || 'main'),
  });
}

/**
 * Build an outcome from an attempt file.
 *
 * A missing or unreadable file yields an honest FAILED outcome rather than an
 * optimistic guess, and a status the control plane cannot actually produce is
 * rejected, so a corrupted or hand-edited attempt file cannot claim SUCCESS.
 */
export function outcomeFromDict(payload, { failureEvidence = '' } = {}) {
  const raw = String(payload.status || '');
  const status = TASK_STATUSES.has(raw) ? raw : STATUS_FAILED;

  return new TaskOutcome({
    status,
    reason: String(payload.reason || payload.error || ''),
    commitSha: payload.commit_created ? String(payload.head_sha || '') : '',
    branch: String(payload.branch || ''),
    pullRequest: payload.pull_request_number ? `#${payload.pull_request_number}` : '',
    pullRequestUrl: String(payload.pull_request_url || ''),
    tests: String(payload.tests || 'not recorded'),
    checkRuns: Array.isArray(payload.check_runs) && payload.check_runs.length
      ? payload.check_runs
          .map((run) => `${run.name}: ${run.conclusion || run.status}`)
          .join('; ')
      : 'not recorded',
    ciResult: String(payload.ci_result || 'not run'),
    recoveryAttempts: Math.max(0, (Number(payload.attempt) || 1) - 1),
    maxAttempts: Number(payload.max_attempts) || 3,
    filesChanged: String(payload.files_changed || 'none'),
    summary: String(payload.agent_text || ''),
    humanAction: String(payload.human_action || 'none'),
    failureEvidence,
  });
}

function postComment(kind, number, body) {
  const command =
    kind === 'pr'
      ? ['gh', 'pr', 'comment', String(number), '--body-file', '-']
      : ['gh', 'issue', 'comment', String(number), '--body-file', '-'];

  const repository = process.env.GITHUB_REPOSITORY;
  if (repository) command.push('--repo', repository);

  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      input: body,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    console.log(`COMMENT_URL=${String(stdout).trim()}`);
    return true;
  } catch (error) {
    console.error(`COMMENT_FAILED=${String(error.stderr || error.message).trim().slice(0, 1000)}`);
    return false;
  }
}

function parseArgs(argv) {
  const args = { trigger: '', attempt: '', out: '', summary: '', post: false, failureEvidence: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--post') {
      args.post = true;
      continue;
    }
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-/g, '_');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[name] = 'true';
    } else {
      args[name] = value;
      i += 1;
    }
  }

  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const triggerPayload = loadJson(args.trigger);
  const attemptPayload = loadJson(args.attempt);

  let failureEvidence = '';
  if (args.failureEvidence) {
    try {
      failureEvidence = fs.readFileSync(args.failureEvidence, 'utf8');
    } catch {
      failureEvidence = '';
    }
  }

  const trigger = triggerFromDict(triggerPayload);
  const outcome = outcomeFromDict(attemptPayload, { failureEvidence });

  const context = new ReportContext({
    trigger,
    outcome,
    secrets: knownSecrets(),
    workflowRunUrl:
      `${process.env.GITHUB_SERVER_URL || ''}/${process.env.GITHUB_REPOSITORY || ''}` +
      `/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
  });

  const report = buildReport(context);
  const summary = buildJobSummary(context);

  if (args.out) fs.writeFileSync(args.out, report, 'utf8');
  if (args.summary) fs.writeFileSync(args.summary, summary, 'utf8');

  console.log('=== JOB SUMMARY ===');
  console.log(summary);

  if (args.post) {
    if (trigger.issueNumber) {
      postComment('issue', trigger.issueNumber, report);
    } else {
      console.log('No issue number; report available in the job summary and the artifact.');
    }
  }

  console.log(`STATUS=${outcome.status}`);

  return outcome.isSuccess ? 0 : 1;
}

/* Run only when executed directly, not when imported by a test. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
