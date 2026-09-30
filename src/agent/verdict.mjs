/**
 * Deciding what actually happened to a task.
 *
 * An OpenCode process exiting zero is NOT evidence that a task was
 * implemented. The same zero exit is produced by several very different
 * situations, and only one of them is a success:
 *
 *   * the work was implemented, committed, pushed, and a PR exists
 *
 * Everything else is a failure that must never be reported as success:
 *
 *   * the agent process itself failed
 *   * the working tree still holds uncommitted changes
 *   * a commit exists but never reached the remote branch
 *   * the commit reached the branch but no pull request was opened
 *   * the push or the PR could not be verified at all
 *   * the local test suite did not pass
 *
 * Every status is derived from observed repository state, never from the
 * agent's exit code. The classification itself is a pure function, so it is
 * testable without a runner, a network or a model.
 */

import { execFileSync } from 'node:child_process';

export const STATUS_SUCCESS = 'SUCCESS';

/**
 * The agent exited cleanly and left the repository untouched. Honest only
 * for a genuinely read-only task, and kept distinct from SUCCESS so a
 * control-plane bug cannot hide a task that did nothing.
 */
export const STATUS_NO_CHANGES = 'SUCCESS_NO_CHANGES';

export const STATUS_DIRTY_NO_COMMIT = 'DIRTY_NO_COMMIT';
export const STATUS_PUSH_FAILED = 'PUSH_FAILED';
export const STATUS_PUSH_UNVERIFIED = 'PUSH_UNVERIFIED';

/** A commit reached the branch but no pull request was opened. */
export const STATUS_NO_PR = 'NO_PULL_REQUEST';

export const STATUS_FAILED = 'FAILED';

export const SUCCESS_STATUSES = new Set([STATUS_SUCCESS, STATUS_NO_CHANGES]);

export const PUSH_PUSHED = 'pushed';
export const PUSH_NOT_PUSHED = 'not-pushed';
export const PUSH_UNKNOWN = 'unknown';

export const PR_OPEN = 'open';
export const PR_MISSING = 'missing';
export const PR_UNKNOWN = 'unknown';

export class Verdict {
  constructor({
    status,
    reason,
    humanAction = 'none',
    dirtyFiles = [],
    commitCreated = false,
    pushState = PUSH_UNKNOWN,
    prState = PR_UNKNOWN,
  }) {
    this.status = status;
    this.reason = reason;
    this.humanAction = humanAction;
    this.dirtyFiles = dirtyFiles;
    this.commitCreated = commitCreated;
    this.pushState = pushState;
    this.prState = prState;
  }

  get isSuccess() {
    return SUCCESS_STATUSES.has(this.status);
  }

  /** Whether a further attempt could plausibly do better. */
  get isRecoverable() {
    return !this.isSuccess;
  }
}

/**
 * Classify one attempt from observed repository state.
 *
 * `agentSucceeded` alone is never sufficient. A clean exit is accepted only
 * when there is a confirmed push of a new commit AND a pull request that
 * exists, and only while the test suite passes.
 */
export function classifyTask({
  agentSucceeded,
  startSha,
  headSha,
  dirtyFiles = [],
  pushState = PUSH_UNKNOWN,
  prState = PR_UNKNOWN,
  testsPassed = true,
  agentTimedOut = false,
  branch = '',
}) {
  const dirty = [...new Set((dirtyFiles || []).map((p) => String(p).trim()).filter(Boolean))];
  const commitCreated = Boolean(headSha) && headSha !== startSha;

  if (!agentSucceeded) {
    return new Verdict({
      status: STATUS_FAILED,
      reason: agentTimedOut
        ? 'the agent run exceeded its time limit and was terminated, so the task is not assumed complete.'
        : 'the agent process did not exit cleanly, so the task is not assumed complete.',
      dirtyFiles: dirty,
      commitCreated,
      pushState,
      prState,
    });
  }

  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(', ');
    const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : '';
    const count = `${dirty.length} file(s) are still uncommitted (${shown}${more})`;

    if (commitCreated) {
      return new Verdict({
        status: STATUS_DIRTY_NO_COMMIT,
        reason:
          `${count}. A commit was created, but the working tree is not clean, so the delivered ` +
          'state is not the state that was worked on.',
        humanAction:
          'Commit the remaining changes, or re-run the task so the agent commits them.',
        dirtyFiles: dirty,
        commitCreated,
        pushState,
        prState,
      });
    }

    return new Verdict({
      status: STATUS_DIRTY_NO_COMMIT,
      reason:
        `${count}. The work exists only on this runner, so nothing reached the repository and ` +
        'no validation could have run against it.',
      humanAction: 'The implementation was never committed. Re-run the task so the agent commits and pushes it.',
      dirtyFiles: dirty,
      commitCreated,
      pushState,
      prState,
    });
  }

  if (!commitCreated) {
    if (!testsPassed) {
      return new Verdict({
        status: STATUS_FAILED,
        reason: 'the agent made no repository change and the test suite did not pass.',
        commitCreated: false,
        pushState,
        prState,
      });
    }

    return new Verdict({
      status: STATUS_NO_CHANGES,
      reason:
        'the agent exited cleanly without changing the repository, which is only a valid outcome ' +
        'for a read-only task.',
      commitCreated: false,
      pushState: PUSH_UNKNOWN,
      prState: PR_UNKNOWN,
    });
  }

  if (pushState === PUSH_NOT_PUSHED) {
    return new Verdict({
      status: STATUS_PUSH_FAILED,
      reason:
        `commit ${headSha} exists locally but is not on the remote branch, so CI would have ` +
        'validated the previous commit.',
      humanAction: 'Push the commit manually, or re-run the task so the agent pushes it.',
      commitCreated: true,
      pushState,
      prState,
    });
  }

  if (pushState !== PUSH_PUSHED) {
    return new Verdict({
      status: STATUS_PUSH_UNVERIFIED,
      reason: `commit ${headSha} was created but the push could not be verified, so success is not claimed.`,
      humanAction: 'Confirm the commit reached the remote branch before trusting this task.',
      commitCreated: true,
      pushState,
      prState,
    });
  }

  if (prState === PR_MISSING) {
    return new Verdict({
      status: STATUS_NO_PR,
      reason:
        `commit ${headSha} was pushed to ${branch || 'the agent branch'} but no pull request targets main, ` +
        'so there is nothing for a human to review and the required-CI checks never ran.',
      humanAction:
        'Open a pull request from the agent branch to main. The agent must never push to main directly.',
      commitCreated: true,
      pushState,
      prState,
    });
  }

  if (prState !== PR_OPEN) {
    return new Verdict({
      status: STATUS_PUSH_UNVERIFIED,
      reason: `commit ${headSha} was pushed but the pull request could not be verified, so success is not claimed.`,
      humanAction: 'Confirm a pull request exists from the agent branch to main.',
      commitCreated: true,
      pushState,
      prState,
    });
  }

  if (!testsPassed) {
    return new Verdict({
      status: STATUS_FAILED,
      reason: `commit ${headSha} was pushed but the local test suite did not pass.`,
      commitCreated: true,
      pushState,
      prState,
    });
  }

  return new Verdict({
    status: STATUS_SUCCESS,
    reason: `commit ${headSha} was pushed, a pull request exists, and the local test suite passed.`,
    commitCreated: true,
    pushState,
    prState,
  });
}

// -------------------------------------------------------------------------
// Repository inspection
// -------------------------------------------------------------------------

/** Run a git subcommand and return trimmed stdout, or '' on failure. */
export function git(args, { allowFailure = true } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

/** Current commit SHA, or '' outside a checkout. */
export function headSha() {
  return git(['rev-parse', 'HEAD']);
}

/**
 * Files the working tree has changed but not committed.
 *
 * Renames are reported under their new path, which is the path the agent
 * would have staged.
 */
export function dirtyFiles() {
  const output = git(['status', '--porcelain']);
  const files = [];

  for (const line of output.split('\n')) {
    if (line.length < 4) continue;

    let entry = line.slice(3).trim();

    // Handle a rename: "old -> new". Keep the destination.
    const arrow = entry.indexOf(' -> ');
    if (arrow !== -1) entry = entry.slice(arrow + 4);

    // Strip surrounding quotes Git adds for paths containing spaces.
    entry = entry.replace(/^"(.*)"$/, '$1');

    if (entry) files.push(entry);
  }

  return files;
}

/** One-line summary of recent commits. */
export function lastCommitSummary(limit = 1) {
  return git(['log', `-${Math.max(1, limit)}`, '--pretty=format:%h %s']);
}

/**
 * Whether `candidate` is reachable from `descendant`.
 *
 * Returns null when git cannot answer, so an unreadable repository is never
 * mistaken for a definitive "no".
 */
export function isAncestor(candidate, descendant) {
  if (!candidate || !descendant) return null;

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidate, descendant], {
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    return null;
  }
}

/** Ask the remote for the tip of a branch. */
export function remoteHeadSha(remote = 'origin', ref = 'main') {
  const output = git(['ls-remote', remote, `refs/heads/${ref}`]);
  if (!output) return '';

  const first = output.split('\n')[0];
  if (!first) return '';

  return first.split('\t')[0].trim();
}

/**
 * Establish whether the remote branch already contains a commit.
 *
 * The local remote-tracking ref is authoritative and needs no network, because
 * a successful `git push` updates it. Only when that ref cannot answer is the
 * remote itself asked.
 */
export function pushState(commitSha, { remote = 'origin', ref = 'main' } = {}) {
  if (!commitSha) return PUSH_UNKNOWN;

  const trackingRef = `${remote}/${ref}`;

  const answer = isAncestor(commitSha, trackingRef);
  if (answer !== null) return answer ? PUSH_PUSHED : PUSH_NOT_PUSHED;

  const remoteHead = remoteHeadSha(remote, ref);
  if (!remoteHead) return PUSH_UNKNOWN;
  if (remoteHead === commitSha) return PUSH_PUSHED;

  const remoteAnswer = isAncestor(commitSha, remoteHead);
  if (remoteAnswer === null) return PUSH_UNKNOWN;

  return remoteAnswer ? PUSH_PUSHED : PUSH_NOT_PUSHED;
}
