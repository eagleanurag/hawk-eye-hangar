/**
 * Driving GitHub: the pull request, the agent branch, and CI observation.
 *
 * The repository's own workflows are the authority for validation. This
 * module never re-implements a check; it triggers nothing, waits on real
 * check runs, and reads their conclusions.
 *
 * Two properties matter more than anything else:
 *
 *   * checks are always resolved by the exact commit SHA the agent pushed,
 *     never by "the latest run", so a concurrent unrelated run can never be
 *     mistaken for this task's result;
 *   * failure output is bounded and redacted before it is handed back to the
 *     model or posted anywhere.
 */

import { execFileSync } from 'node:child_process';

export const DEFAULT_BASE_BRANCH = 'main';
export const POLL_INTERVAL_SECONDS = 20;
export const MAX_POLL_SECONDS = 3600;

/** Bounded so a failure cannot flood the model context or an issue comment. */
export const MAX_LOG_CHARACTERS = 20000;

export class CIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CIError';
  }
}

/** A very small, mockable wrapper over the GitHub CLI. */
export class GitHubCLI {
  constructor({ repository = '', runner = execFileSync } = {}) {
    this.repository = repository;
    this.runner = runner;
  }

  #command(arguments_) {
    const command = ['gh', ...arguments_];
    if (this.repository) command.push('--repo', this.repository);
    return command;
  }

  run(arguments_, { check = true, input } = {}) {
    const command = this.#command(arguments_);

    try {
      const stdout = this.runner(command[0], command.slice(1), {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { returncode: 0, stdout: String(stdout || ''), stderr: '' };
    } catch (error) {
      const result = {
        returncode: typeof error.status === 'number' ? error.status : 1,
        stdout: String(error.stdout || ''),
        stderr: String(error.stderr || ''),
      };
      if (check) {
        throw new CIError(
          `\`gh ${arguments_.slice(0, 3).join(' ')} ...\` failed with exit ${result.returncode}: ` +
            `${result.stderr.trim().slice(0, 2000)}`
        );
      }
      return result;
    }
  }

  json(arguments_, { defaultValue = undefined } = {}) {
    const result = this.run(arguments_, { check: false });
    if (result.returncode !== 0) {
      if (defaultValue !== undefined) return defaultValue;
      throw new CIError(`gh ${arguments_.join(' ')} failed: ${result.stderr.trim().slice(0, 2000)}`);
    }

    const text = result.stdout.trim();
    if (!text) return defaultValue !== undefined ? defaultValue : {};

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new CIError(`Could not parse gh output as JSON: ${error.message}`);
    }
  }
}

/** The resolved state of one pull request. */
export class PullRequest {
  constructor({ number, url, state, baseRefName, headRefName, headSha }) {
    this.number = number;
    this.url = url;
    this.state = state;
    this.baseRefName = baseRefName;
    this.headRefName = headRefName;
    this.headSha = headSha;
  }

  get isOpen() {
    return this.state === 'open';
  }
}

/** One CI run tied to a specific commit. */
export class CheckRun {
  constructor({ runId, name, status, conclusion, url, headSha }) {
    this.runId = runId;
    this.name = name;
    this.status = status;
    this.conclusion = conclusion;
    this.url = url;
    this.headSha = headSha;
  }

  get isComplete() {
    return this.status === 'completed';
  }

  get succeeded() {
    return this.conclusion === 'success' || this.conclusion === 'skipped';
  }

  get failed() {
    return ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(
      this.conclusion
    );
  }

  get isPending() {
    return !this.isComplete;
  }
}

export class GitHub {
  constructor(options = {}) {
    this.cli = options.cli || new GitHubCLI({ repository: options.repository });
    this.baseBranch = options.baseBranch || DEFAULT_BASE_BRANCH;
  }

  /**
   * Find an open pull request whose head is `branch` and whose base is main.
   *
   * Resolved by head branch rather than by run id, so a re-run or a repair
   * cycle finds the same PR instead of opening a second one.
   */
  findPullRequest(branch) {
    const payload = this.cli.json(
      [
        'pr', 'list',
        '--head', branch,
        '--base', this.baseBranch,
        '--state', 'open',
        '--json', 'number,url,state,baseRefName,headRefName,headRefOid',
        '--limit', '5',
      ],
      { defaultValue: [] }
    );

    if (!Array.isArray(payload) || !payload.length) return null;

    const entry = payload[0];
    if (!entry || typeof entry !== 'object') return null;

    return new PullRequest({
      number: String(entry.number || ''),
      url: String(entry.url || ''),
      state: String(entry.state || ''),
      baseRefName: String(entry.baseRefName || ''),
      headRefName: String(entry.headRefName || ''),
      headSha: String(entry.headRefOid || ''),
    });
  }

  /** Open a pull request, or return the existing one. */
  ensurePullRequest({ branch, title, body }) {
    const existing = this.findPullRequest(branch);
    if (existing) return { pullRequest: existing, created: false };

    const result = this.cli.run(
      ['pr', 'create', '--head', branch, '--base', this.baseBranch, '--title', title, '--body', body],
      { check: false }
    );

    if (result.returncode !== 0) {
      // A concurrent run may have created it between the check and here.
      const raced = this.findPullRequest(branch);
      if (raced) return { pullRequest: raced, created: false };
      throw new CIError(`Could not open a pull request: ${result.stderr.trim().slice(0, 2000)}`);
    }

    const url = result.stdout.trim();
    const created = this.findPullRequest(branch) ||
      new PullRequest({ number: '', url, state: 'open', baseRefName: this.baseBranch, headRefName: branch, headSha: '' });

    return { pullRequest: created, created: true };
  }

  /** Post (or update) a comment on a pull request. */
  commentOnPullRequest(number, body) {
    if (!number) return false;
    const result = this.cli.run(['pr', 'comment', String(number), '--body', body], { check: false });
    return result.returncode === 0;
  }

  /**
   * Every check run that belongs to exactly this commit.
   *
   * `--commit` is the critical filter. Without it a run started by a
   * concurrent push would be reported as this task's result.
   */
  findRunsForCommit(commitSha, { limit = 20 } = {}) {
    const payload = this.cli.json(
      [
        'run', 'list',
        '--commit', commitSha,
        '--limit', String(limit),
        '--json', 'databaseId,name,status,conclusion,url,headSha',
      ],
      { defaultValue: [] }
    );

    if (!Array.isArray(payload)) return [];

    return payload
      .filter((entry) => entry && entry.headSha === commitSha)
      .map(
        (entry) =>
          new CheckRun({
            runId: String(entry.databaseId || ''),
            name: String(entry.name || ''),
            status: String(entry.status || ''),
            conclusion: String(entry.conclusion || ''),
            url: String(entry.url || ''),
            headSha: commitSha,
          })
      );
  }

  /** Bounded failing-step logs for a run. */
  failedLogs(runId) {
    if (!runId) return '';
    const result = this.cli.run(['run', 'view', String(runId), '--log-failed'], { check: false });
    return boundLog(`${result.stdout}${result.stderr}`);
  }
}

/**
 * Wait for every check on `commitSha` to reach a terminal state.
 *
 * Resolves to the run list. `timeoutSeconds` bounds the wait so a stuck
 * queue cannot consume the whole job.
 */
export async function waitForChecks(github, commitSha, { timeoutSeconds = MAX_POLL_SECONDS } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  let runs = github.findRunsForCommit(commitSha);

  while (Date.now() < deadline) {
    runs = github.findRunsForCommit(commitSha);

    if (runs.length && runs.every((run) => run.isComplete)) return runs;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_SECONDS * 1000));
  }

  return runs;
}

/** Keep the head and tail of a log, dropping the middle. */
export function boundLog(text) {
  const cleaned = String(text || '').trim();
  if (cleaned.length <= MAX_LOG_CHARACTERS) return cleaned;

  const head = Math.floor(MAX_LOG_CHARACTERS / 3);
  const tail = MAX_LOG_CHARACTERS - head - 60;
  const omitted = cleaned.length - head - tail;

  return (
    `${cleaned.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${cleaned.slice(-tail)}`
  );
}

/** Classify a failed check run for the agent. */
export function summarizeFailure(run) {
  if (run.conclusion === 'cancelled') {
    return 'The check run was cancelled. It may have been superseded or interrupted.';
  }
  if (run.conclusion === 'timed_out') {
    return 'The check run exceeded the GitHub Actions time limit.';
  }
  if (run.conclusion === 'action_required') {
    return 'The check run needs an approving review before it can complete.';
  }
  return `The "${run.name}" workflow failed. The logs below are from the failing steps.`;
}

/** Summarize an overall CI outcome. */
export function summarizeChecks(runs) {
  if (!runs.length) return 'no check runs were found for this commit';

  const failed = runs.filter((run) => run.failed);
  const pending = runs.filter((run) => run.isPending);

  if (failed.length) return `${failed.length} of ${runs.length} check(s) failed: ${failed.map((r) => r.name).join(', ')}`;
  if (pending.length) return `${pending.length} of ${runs.length} check(s) still running`;
  return `all ${runs.length} check(s) passed: ${runs.map((r) => r.name).join(', ')}`;
}
