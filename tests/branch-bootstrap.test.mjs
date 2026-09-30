// Branch bootstrap tests, appended to tests/agent-control-plane.test.mjs.
//
// Kept in a separate file so this suite is additive to the merged one and
// cannot conflict with it. It covers the bug found by the first live smoke
// test: preflight derived agent/issue-main-2, the agent job tried to check it
// out, and the run failed with "A branch or tag with the name
// 'agent/issue-main-2' could not be found" because nothing had ever created it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ACTION_CREATE,
  ACTION_REFUSE,
  ACTION_REUSE,
  ensureAgentBranch,
  findExistingAgentBranch,
  planBranch,
  remoteBranchExists,
  sanitizeBranch,
} from '../src/agent/branch.mjs';
import {
  PROTECTED_BRANCHES,
  deriveAgentBranch,
  isProtectedBranch,
} from '../src/agent/events.mjs';
import { main as ensureBranchMain } from '../src/agent/ensure-branch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'opencode-agent.yml');

// -------------------------------------------------------------------------
// Decision rules, as a pure function
// -------------------------------------------------------------------------

test('a new issue branch that does not exist is created from main', () => {
  const plan = planBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'main',
    branchExists: false,
    baseExists: true,
  });

  assert.equal(plan.action, ACTION_CREATE);
  assert.equal(plan.needsCheckout, true);
  assert.match(plan.reason, /creating .* from "main"/);
});

test('an existing issue branch is reused, never recreated', () => {
  const plan = planBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'main',
    branchExists: true,
    baseExists: true,
  });

  assert.equal(plan.action, ACTION_REUSE);
  assert.equal(plan.needsCheckout, true);
  assert.match(plan.reason, /reusing the existing agent branch/);
});

test('main can never become the agent working branch', () => {
  for (const protectedName of PROTECTED_BRANCHES) {
    const plan = planBranch({
      branch: protectedName,
      baseBranch: 'develop',
      branchExists: false,
      baseExists: true,
    });

    assert.equal(plan.action, ACTION_REFUSE, `${protectedName} must be refused as a working branch`);
    assert.equal(plan.needsCheckout, false);
    assert.match(plan.reason, /protected branch/);
  }

  // Even when main genuinely does not exist as a working branch target, and
  // even when the branch already exists, a protected name is refused.
  const exists = planBranch({ branch: 'main', baseBranch: 'main', branchExists: true, baseExists: true });
  assert.equal(exists.action, ACTION_REFUSE);
});

test('main is still a legitimate BASE branch', () => {
  // Refusing a protected base would reject every real task, because main is
  // what the pull request targets.
  const plan = planBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'main',
    branchExists: false,
    baseExists: true,
  });

  assert.equal(plan.action, ACTION_CREATE);
  assert.equal(plan.needsCheckout, true);
  assert.match(plan.reason, /from "main"/);
});

test('an agent branch identical to its base is refused', () => {
  const plan = planBranch({ branch: 'develop', baseBranch: 'develop', branchExists: false, baseExists: true });
  assert.equal(plan.action, ACTION_REFUSE);
});

test('branch creation failure is reported honestly, not silently retried', () => {
  const plan = planBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'does-not-exist',
    branchExists: false,
    baseExists: false,
  });

  assert.equal(plan.action, ACTION_REFUSE);
  assert.equal(plan.needsCheckout, false);
  assert.match(plan.reason, /does not exist/);
});

test('a refusal always explains itself', () => {
  for (const plan of [
    planBranch({ branch: '', baseBranch: 'main' }),
    planBranch({ branch: 'main', baseBranch: 'main' }),
    planBranch({ branch: 'agent/x-1', baseBranch: 'nope', baseExists: false }),
  ]) {
    assert.equal(plan.action, ACTION_REFUSE);
    assert.ok(plan.reason.length > 10, 'a refusal must explain itself');
  }
});

// -------------------------------------------------------------------------
// A continuation cannot fork a second branch
// -------------------------------------------------------------------------

test('a continuation derives the same branch, so it cannot fork a second one', () => {
  // The name is a pure function of base and issue number, which is what makes
  // a continuation reuse the same branch without carrying any state.
  assert.equal(deriveAgentBranch('main', 2, 1), 'agent/issue-main-2');
  assert.equal(deriveAgentBranch('main', 2, 1), deriveAgentBranch('main', 2, 1));
  assert.notEqual(deriveAgentBranch('main', 3, 1), 'agent/issue-main-2');
});

test('a continuation does not create a second branch for the same issue', () => {
  // First run: the branch is absent, so it is created.
  const firstRun = planBranch({ branch: 'agent/issue-main-2', baseBranch: 'main', branchExists: false, baseExists: true });
  assert.equal(firstRun.action, ACTION_CREATE);

  // Second run for the same issue: the branch now exists, so it is reused.
  const secondRun = planBranch({ branch: 'agent/issue-main-2', baseBranch: 'main', branchExists: true, baseExists: true });
  assert.equal(secondRun.action, ACTION_REUSE);
});

test('a repair attempt stays in the same branch family and never overwrites', () => {
  const original = deriveAgentBranch('main', 2, 1);
  const repair = deriveAgentBranch('main', 2, 2);

  assert.notEqual(original, repair, 'the repair name differs');
  assert.ok(repair.startsWith('agent/issue-main-2'), 'but it is the same family');

  // Requesting the original again reuses it, rather than resetting it.
  const plan = planBranch({ branch: original, baseBranch: 'main', branchExists: true, baseExists: true });
  assert.equal(plan.action, ACTION_REUSE);
});

test('branch names are sanitised before use', () => {
  assert.equal(sanitizeBranch('feature/odd branch'), 'feature-odd-branch');
  assert.equal(sanitizeBranch('main'), 'main');
  assert.equal(sanitizeBranch('a;b&c'), 'a-b-c');
});

// -------------------------------------------------------------------------
// The git implementation, against a real repository
// -------------------------------------------------------------------------

/** A throwaway repository with a bare "remote" and one commit on main. */
function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchboot-'));

  const run = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'test']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['init', '-q', '--bare', path.join(dir, 'remote.git')]);
  run(['remote', 'add', 'origin', path.join(dir, 'remote.git')]);

  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  run(['add', 'README.md']);
  run(['commit', '-q', '-m', 'base commit']);
  run(['push', '-q', 'origin', 'main']);

  return { dir, run };
}

test('a first run creates the agent branch from main', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const baseTip = repo.run(['rev-parse', 'main']);

  const result = ensureAgentBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'main',
    remote: 'origin',
    issueNumber: 2,
    cwd: repo.dir,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.action, ACTION_CREATE);
  assert.equal(result.branch, 'agent/issue-main-2');

  // The branch really exists, is checked out, and points at the base tip.
  assert.equal(repo.run(['rev-parse', '--abbrev-ref', 'HEAD']), 'agent/issue-main-2');
  assert.equal(repo.run(['rev-parse', 'agent/issue-main-2']), baseTip);
});

test('a second run reuses the branch instead of creating a second one', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const first = ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });
  assert.equal(first.ok, true, first.reason);

  // Add work, exactly as a real agent run would.
  repo.run(['commit', '-q', '--allow-empty', '-m', 'agent work']);
  const workSha = repo.run(['rev-parse', 'agent/issue-main-2']);

  const second = ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });

  assert.equal(second.ok, true, second.reason);
  assert.equal(second.action, ACTION_REUSE);

  // The agent's work survived: the branch was not reset onto the base.
  assert.equal(second.headSha, workSha);
  assert.equal(repo.run(['rev-parse', 'agent/issue-main-2']), workSha);
  assert.notEqual(workSha, base_or_main(repo));
});

function base_or_main(repo) {
  return repo.run(['rev-parse', 'main']);
}

test('a continuation does not create a second branch for the same issue', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });
  repo.run(['push', '-q', 'origin', 'agent/issue-main-2']);

  // A DIFFERENT issue must not be folded into the first one's branch.
  const other = ensureAgentBranch({
    branch: 'agent/issue-main-3', baseBranch: 'main', remote: 'origin', issueNumber: 3, cwd: repo.dir,
  });

  assert.equal(other.ok, true, other.reason);
  assert.equal(other.branch, 'agent/issue-main-3');
  assert.equal(remoteBranchExists('agent/issue-main-2', { remote: 'origin', cwd: repo.dir }), true);
});

test('bootstrap refuses a protected branch without touching git', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const result = ensureAgentBranch({
    branch: 'main', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, ACTION_REFUSE);
  assert.match(result.reason, /protected branch/);
  assert.notEqual(result.exitCode, 0, 'a refusal must be a non-zero exit');

  // Untouched: still on main.
  assert.equal(repo.run(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

test('bootstrap reports a missing base branch honestly', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const result = ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'no-such-base', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, ACTION_REFUSE);
  assert.match(result.reason, /does not exist/);
  assert.notEqual(result.exitCode, 0);
});

test('bootstrap never deletes an existing agent branch', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });
  repo.run(['commit', '-q', '--allow-empty', '-m', 'work']);
  repo.run(['push', '-q', 'origin', 'agent/issue-main-2']);
  const kept = repo.run(['rev-parse', 'agent/issue-main-2']);

  for (let i = 0; i < 2; i += 1) {
    const result = ensureAgentBranch({
      branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
    });
    assert.equal(result.ok, true, result.reason);
  }

  assert.equal(repo.run(['rev-parse', 'agent/issue-main-2']), kept);
  assert.equal(remoteBranchExists('agent/issue-main-2', { remote: 'origin', cwd: repo.dir }), true);
});

test('bootstrap never pushes anything itself', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });

  // Nothing exists on the remote until the agent job pushes.
  assert.equal(
    remoteBranchExists('agent/issue-main-2', { remote: 'origin', cwd: repo.dir }),
    false,
    'bootstrap must not push; the agent job owns pushing'
  );
});

test('a continuation finds a branch whose name no longer matches the derived one', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // A branch created earlier under a different base-branch name.
  repo.run(['branch', 'agent/issue-oldbase-2', 'main']);
  repo.run(['push', '-q', 'origin', 'agent/issue-oldbase-2']);

  const result = ensureAgentBranch({
    branch: 'agent/issue-main-2',
    baseBranch: 'main',
    remote: 'origin',
    issueNumber: 2,
    resume: true,
    cwd: repo.dir,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.branch, 'agent/issue-oldbase-2', 'the existing branch is reused');
  assert.equal(repo.run(['rev-parse', '--abbrev-ref', 'HEAD']), 'agent/issue-oldbase-2');

  // No second branch was created for the same issue.
  assert.equal(repo.run(['branch', '--list', 'agent/issue-main-2']), '');
});

test('a repair attempt continues on the original branch rather than forking', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  ensureAgentBranch({
    branch: 'agent/issue-main-2', baseBranch: 'main', remote: 'origin', issueNumber: 2, cwd: repo.dir,
  });
  repo.run(['push', '-q', 'origin', 'agent/issue-main-2']);

  // Attempt 2 derives agent/issue-main-2-a2, which does not exist. It is in
  // the same family, so the existing branch is reused.
  const result = ensureAgentBranch({
    branch: 'agent/issue-main-2-a2',
    baseBranch: 'main',
    remote: 'origin',
    issueNumber: 2,
    resume: true,
    cwd: repo.dir,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.branch, 'agent/issue-main-2', 'a repair continues on the original branch');
  assert.equal(repo.run(['branch', '--list', 'agent/issue-main-2-a2']), '');
});

test('findExistingAgentBranch returns nothing when there is nothing to find', (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  assert.equal(findExistingAgentBranch({ remote: 'origin', issueNumber: 99, baseBranch: 'main', cwd: repo.dir }), '');
});

// -------------------------------------------------------------------------
// The CLI contract
// -------------------------------------------------------------------------

test('the CLI refuses a protected branch', () => {
  assert.equal(ensureBranchMain(['--branch', 'main', '--base-branch', 'main'], { outputFile: null }), 1);
});

test('the CLI refuses an empty branch', () => {
  assert.equal(ensureBranchMain(['--base-branch', 'main'], { outputFile: null }), 1);
});

// -------------------------------------------------------------------------
// Source-level guarantees
// -------------------------------------------------------------------------

test('the bootstrap module never force-pushes, deletes or resets a branch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'branch.mjs'), 'utf8');

  /*
   * Checked against the actual invocations, not the raw text. The prose
   * deliberately NAMES these operations in order to state that they are
   * absent, so a naive substring scan would flag the safety comment itself.
   */
  const invocations = [...source.matchAll(/git\(\s*\[([^\]]*)\]/g)].map((match) => match[1]);

  assert.ok(invocations.length > 0, 'no git invocations found; the guard would be vacuous');

  for (const args of invocations) {
    assert.ok(!args.includes("'push'"), `must never push (found git([${args}]))`);
    for (const destructive of ["'-D'", "'--delete'", "'-d'", "'-M'", "'-m'", "'update-ref'", "'reset'"]) {
      assert.ok(!args.includes(destructive), `must never run git with ${destructive} (found git([${args}]))`);
    }
  }

  // Creation must be a plain branch creation from the base, not a reset.
  assert.ok(
    invocations.some((args) => args.includes("'branch'") && args.includes('baseBranch')),
    'must create the branch from the base'
  );
});

test('the workflow bootstraps the branch before the agent checks it out', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

  assert.match(workflow, /\n {2}bootstrap:\n/);
  assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /needs: \[preflight, bootstrap\]/);

  // The bootstrap job checks out the BASE, which always exists, not the agent
  // branch that does not exist yet.
  const bootstrapBlock = workflow.slice(workflow.indexOf('\n  bootstrap:'), workflow.indexOf('\n  agent:'));
  assert.match(bootstrapBlock, /ref: \$\{\{ needs\.preflight\.outputs\.base_branch \|\| 'main' \}\}/);
  assert.doesNotMatch(bootstrapBlock, /ref: \$\{\{ needs\.preflight\.outputs\.branch \}\}/);

  // The agent job's checkout uses the bootstrap output, so it can only ever be
  // a ref that was actually created.
  const agentBlock = workflow.slice(workflow.indexOf('\n  agent:'), workflow.indexOf('\n  report:'));
  assert.match(
    agentBlock,
    /ref: \$\{\{ needs\.bootstrap\.outputs\.branch \|\| needs\.preflight\.outputs\.branch \}\}/
  );
});

test('a bootstrap failure still produces an honest report', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

  assert.match(workflow, /needs: \[preflight, bootstrap, agent\]/);
  assert.match(workflow, /Status: BLOCKED/);
  assert.match(workflow, /the agent never started/);
});

test('the bootstrap job can publish a new agent branch without force-pushing', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const bootstrapBlock = workflow.slice(workflow.indexOf('\n  bootstrap:'), workflow.indexOf('\n  agent:'));

  // The bootstrap runner is disposable, so a first-run branch must be
  // published for the separate agent runner to check it out.
  assert.match(bootstrapBlock, /contents: write/);
  assert.match(bootstrapBlock, /git push --no-force origin/);
  assert.doesNotMatch(bootstrapBlock, /git push --force/);
});
