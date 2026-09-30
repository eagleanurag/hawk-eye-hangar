/**
 * Deterministic agent-branch bootstrap.
 *
 * The problem this solves
 * -----------------------
 * The control plane derives an agent branch in preflight, but a branch that
 * exists only as a name does not exist to GitHub. `actions/checkout` with
 * `ref: agent/issue-main-2` fails outright on a first run with
 *
 *     A branch or tag with the name 'agent/issue-main-2' could not be found
 *
 * and the agent never starts. The name has to be *created* from the base
 * branch before anything can check it out.
 *
 * The rules
 * ---------
 * A first run for an issue has no branch, so one is created from the base.
 * A continuation for an issue that already has a branch reuses that branch
 * rather than starting a second one. The branch name is a pure function of
 * (base branch, issue number), so a continuation derives the same name without
 * any state being carried between runs.
 *
 * What this module will never do:
 *
 *   * point the agent at a protected branch, so `main` can never become the
 *     working branch even if a name collision or a bad input suggests it;
 *   * delete an existing agent branch, because that would destroy work in
 *     flight for any run still using it;
 *   * force-push, or reset an existing branch onto a different history;
 *   * overwrite an existing branch. If the branch is already there, it is
 *     reused as-is and only checked out.
 *
 * Safety under concurrency
 * ------------------------
 * Branch existence is resolved with `ls-remote`, which asks the remote rather
 * than trusting a local ref that may be stale. Two runs racing on the same
 * issue both derive the same name, so at worst one creates the branch and the
 * other observes it and reuses it. Creation is a plain branch creation from
 * the base tip, never a reset, so a losing racer cannot clobber anything.
 *
 * The decision logic is separated from git entirely and is a pure function,
 * so every rule above is testable without a repository, a network or a model.
 */

import { execFileSync } from 'node:child_process';
import { isProtectedBranch, PROTECTED_BRANCHES } from './events.mjs';

export const ACTION_CREATE = 'create';
export const ACTION_REUSE = 'reuse';
export const ACTION_REFUSE = 'refuse';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/**
 * Decide what to do with an agent branch.
 *
 * Pure: it takes the observed state and returns the decision, so the rules are
 * testable on their own and cannot drift from the git implementation by
 * accident.
 *
 * @param {object} state
 * @param {string} state.branch         the derived agent branch
 * @param {string} state.baseBranch     the branch to create from
 * @param {boolean} state.branchExists  whether the branch already exists
 * @param {boolean} state.baseExists    whether the base branch exists
 * @returns {{action: string, reason: string, needsCheckout: boolean}}
 */
export function planBranch({ branch, baseBranch = 'main', branchExists = false, baseExists = true }) {
  if (!branch || !String(branch).trim()) {
    return { action: ACTION_REFUSE, reason: 'no agent branch was derived', needsCheckout: false };
  }

  /*
   * The safety rule that matters most: the agent never works on a protected
   * branch, whatever produced the name.
   *
   * Note this is checked against the WORKING branch only. The base branch is
   * expected to be `main` — that is what the pull request targets — so
   * refusing a protected base would reject every legitimate task.
   */
  if (isProtectedBranch(branch)) {
    return {
      action: ACTION_REFUSE,
      reason:
        `refusing to work on "${branch}": a protected branch (${PROTECTED_BRANCHES.join(', ')}) ` +
        'can never be the agent working branch',
      needsCheckout: false,
    };
  }

  if (branch === baseBranch) {
    return {
      action: ACTION_REFUSE,
      reason: `the agent branch and base branch are both "${branch}"`,
      needsCheckout: false,
    };
  }

  if (branchExists) {
    // Reuse. Never reset, never force, never delete: the branch holds work
    // that a continuation is meant to continue.
    return {
      action: ACTION_REUSE,
      reason: `reusing the existing agent branch "${branch}"`,
      needsCheckout: true,
    };
  }

  if (!baseExists) {
    return {
      action: ACTION_REFUSE,
      reason: `the base branch "${baseBranch}" does not exist, so "${branch}" cannot be created from it`,
      needsCheckout: false,
    };
  }

  return {
    action: ACTION_CREATE,
    reason: `creating "${branch}" from "${baseBranch}"`,
    needsCheckout: true,
  };
}

/** Make a branch fragment safe to embed in a branch name. */
export function sanitizeBranch(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Find an existing agent branch for an issue, in case the derived name does
 * not match one that is already there.
 *
 * This is what stops a continuation from silently starting a second branch.
 * If the base branch was ever renamed, or the derived name changed with a
 * code change, the run still finds the branch the previous run used and
 * continues on it instead of forking the work.
 *
 * Returns '' when there is exactly nothing to find. When several candidates
 * exist the name-sorted first is returned, so the choice is deterministic
 * rather than dependent on the remote's ordering.
 */
export function findExistingAgentBranch({ remote = 'origin', issueNumber, baseBranch = 'main', cwd } = {}) {
  if (!Number.isFinite(issueNumber)) return '';

  const wanted = `agent/issue-${sanitizeBranch(baseBranch)}-${issueNumber}`;

  let refs = [];
  try {
    refs = execFileSync('git', ['ls-remote', '--heads', remote, 'agent/issue-*'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
      .split('\n')
      .map((line) => line.split('\t')[1] || '')
      .map((ref) => ref.replace(/^refs\/heads\//, ''))
      .filter(Boolean);
  } catch {
    return '';
  }

  // An exact name match always wins, whatever its timestamp.
  if (refs.includes(wanted)) return wanted;

  /*
   * Otherwise match by ISSUE, not by the base-branch fragment.
   *
   * The base branch appears in the name only to keep distinct bases apart, so
   * it is not a stable identity. A branch named after a base that no longer
   * exists, or one whose derived name changed with a code update, still
   * belongs to this issue and must be continued rather than forked.
   *
   * Shape: agent/issue-<base>-<number>, optionally with an -a<n> repair suffix.
   */
  const number = String(issueNumber);
  const family = refs
    .filter((ref) => {
      if (!ref.startsWith('agent/issue-')) return false;
      const tail = ref.slice('agent/issue-'.length).replace(/-a\d+$/, '');
      // The final segment must be the issue number.
      return tail.split('-').pop() === number;
    })
    .sort();

  return family[0] || '';
}

/** Whether a branch exists on the remote. */
export function remoteBranchExists(branch, { remote = 'origin', cwd } = {}) {
  if (!branch) return false;

  try {
    const out = execFileSync('git', ['ls-remote', '--heads', remote, `refs/heads/${branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    return Boolean(out.trim());
  } catch {
    return false;
  }
}

/** Whether a ref exists in the local repository. */
export function localRefExists(ref, { cwd } = {}) {
  if (!ref) return false;

  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(args, { allowFailure = false, cwd } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw new Error(
      `git ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr || error.message).trim().slice(0, 500)}`
    );
  }
}

/**
 * Ensure the agent branch exists locally, and check it out.
 *
 * Called from the workflow after a checkout of the BASE branch, because
 * checking out a branch that does not exist is precisely the failure this
 * module exists to prevent.
 *
 * A refusal or a git failure is reported honestly through a non-zero exit
 * rather than being papered over, so a broken bootstrap can never be mistaken
 * for a run that simply had nothing to do.
 */
export function ensureAgentBranch({
  branch,
  baseBranch = 'main',
  remote = 'origin',
  issueNumber = null,
  resume = true,
  cwd,
} = {}) {
  let target = branch;
  let reusedExisting = false;

  if (resume && Number.isFinite(issueNumber) && !remoteBranchExists(target, { remote, cwd })) {
    // The derived name is absent, but this issue may already own a branch
    // under a different name. Reuse that rather than starting a second one.
    const discovered = findExistingAgentBranch({ remote, issueNumber, baseBranch, cwd });
    if (discovered && discovered !== target) {
      target = discovered;
      reusedExisting = true;
      console.log(`BRANCH_DISCOVERED=${target}`);
    }
  }

  const branchExists =
    remoteBranchExists(target, { remote, cwd }) || localRefExists(`refs/heads/${target}`, { cwd });
  const baseExists =
    remoteBranchExists(baseBranch, { remote, cwd }) || localRefExists(`refs/heads/${baseBranch}`, { cwd });

  const plan = planBranch({ branch: target, baseBranch, branchExists, baseExists });

  if (plan.action === ACTION_REFUSE) {
    console.error(`BRANCH_REFUSED=${plan.reason}`);
    return { ok: false, action: ACTION_REFUSE, reason: plan.reason, branch: target, exitCode: EXIT_ERROR };
  }

  if (plan.action === ACTION_CREATE) {
    try {
      /*
       * Create from the base tip. Deliberately a plain branch creation: no
       * reset, no force, no update-ref, so a branch that appeared between the
       * check and here is left alone rather than overwritten.
       *
       * The ref is fully qualified so the command cannot be ambiguous. An
       * unqualified `git branch <name> <start>` is only reliable when the
       * start point exists as a local branch, and a bare `main` is ambiguous
       * when both a local and a remote-tracking ref of that name exist.
       */
      if (localRefExists(`refs/heads/${target}`, { cwd })) {
        console.log(`BRANCH_RACE_LOST=${target} already exists locally; reusing it`);
      } else {
        git(['branch', target, `refs/heads/${baseBranch}`], { cwd });
        console.log(`BRANCH_CREATED=${target} from ${baseBranch}`);
      }
    } catch (error) {
      const reason = `could not create "${target}" from "${baseBranch}": ${error.message}`;
      console.error(`BRANCH_CREATE_FAILED=${reason}`);
      return { ok: false, action: ACTION_CREATE, reason, branch: target, exitCode: EXIT_ERROR };
    }
  } else {
    console.log(`BRANCH_REUSED=${target}`);
  }

  // Make the base available locally, so both creation and inspection work.
  git(['fetch', remote, baseBranch, '--no-tags'], { allowFailure: true, cwd });

  try {
    git(['checkout', target], { cwd });
  } catch (error) {
    const reason = `could not check out "${target}": ${error.message}`;
    console.error(`BRANCH_CHECKOUT_FAILED=${reason}`);
    return { ok: false, action: plan.action, reason, branch: target, exitCode: EXIT_ERROR };
  }

  const head = git(['rev-parse', 'HEAD'], { allowFailure: true, cwd });

  return {
    ok: true,
    action: reusedExisting ? ACTION_REUSE : plan.action,
    reason: plan.reason,
    branch: target,
    headSha: head,
    exitCode: EXIT_OK,
  };
}
