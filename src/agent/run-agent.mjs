#!/usr/bin/env node
/**
 * Run one OpenCode attempt and record the outcome as JSON.
 *
 * Writes a result file that later steps read, so nothing has to cross a step
 * boundary through `$GITHUB_OUTPUT` (fragile for multi-line text).
 *
 *     node src/agent/run-agent.mjs \
 *       --trigger .agent/trigger.json \
 *       --prompt agent-prompt.md \
 *       --out attempt-1.json \
 *       --attempt 1 --max-attempts 3
 *
 * The exit code is 0 only when the task is genuinely delivered: committed,
 * pushed, and accompanied by a pull request. A clean OpenCode exit is not
 * sufficient and is never reported as success on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { deriveAgentBranch, derivePullRequestTitle, isProtectedBranch } from './events.mjs';
import { GitHub, boundLog, summarizeChecks, summarizeFailure, waitForChecks } from './ci.mjs';
import { isOpenCodeAvailable, runOpenCode, DEFAULT_AGENT, DEFAULT_MODEL, DEFAULT_TIMEOUT_SECONDS, DEFAULT_VERSION } from './opencode.mjs';
import { knownSecrets, redact } from './redaction.mjs';
import { STATUS_BLOCKED, TASK_STATUSES, TaskOutcome } from './reporting.mjs';
import {
  PUSH_NOT_PUSHED,
  PUSH_PUSHED,
  PUSH_UNKNOWN,
  PR_MISSING,
  PR_OPEN,
  PR_UNKNOWN,
  STATUS_FAILED,
  classifyTask,
  dirtyFiles,
  headSha,
  lastCommitSummary,
  pushState,
} from './verdict.mjs';

/** Validation commands, matching the project's package.json. */
export const VALIDATION_COMMANDS = {
  always: [
    ['npm', 'test'],
    ['npm', 'run', 'build'],
    ['npm', 'run', 'check-links'],
    ['npm', 'run', 'audit'],
  ],
  visual: [['npm', 'run', 'qa']],
};

/**
 * Run a command, returning a bounded summary and whether it passed.
 *
 * Never throws: a red suite must be reportable, not fatal.
 */
export function runCommand(command, { cwd = process.cwd(), timeoutMs = 900000 } = {}) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { passed: true, output: String(stdout || '').slice(-4000) };
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.slice(-4000);
    return { passed: false, output: output || error.message };
  }
}

/** Run the project's test suite and summarize it. */
export function testSuitePassed({ cwd } = {}) {
  const result = runCommand(['npm', 'test'], { cwd });
  return { passed: result.passed, summary: result.passed ? 'PASSED (npm test)' : `FAILED\n${result.output}` };
}

function loadJson(pathname) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBlocked(pathname, reason, humanAction, extra = {}) {
  const payload = {
    status: STATUS_BLOCKED,
    reason,
    human_action: humanAction,
    head_sha: headSha(),
    commit_created: false,
    push_state: PUSH_UNKNOWN,
    pr_state: PR_UNKNOWN,
    recoverable: false,
    ...extra,
  };
  fs.writeFileSync(pathname, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

const DEFAULT_ARGS = {
  trigger: '',
  prompt: '',
  out: 'attempt.json',
  baseBranch: 'main',
  model: DEFAULT_MODEL,
  agent: DEFAULT_AGENT,
  version: DEFAULT_VERSION,
  timeout: String(DEFAULT_TIMEOUT_SECONDS),
  attempt: '1',
  maxAttempts: '3',
  continueSession: false,
  skipInstall: false,
  waitForCi: true,
};

/**
 * Parse `--flag value` pairs, converting kebab-case flags to camelCase keys.
 *
 * The conversion matters: keeping the raw snake_case name would silently write
 * `base_branch` into the argument object while the rest of this module reads
 * `baseBranch`, so the flag would appear to be ignored.
 */
function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;

    const name = key.slice(2).replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase());

    if (name === 'noWait') {
      args.waitForCi = false;
      continue;
    }

    if (!(name in DEFAULT_ARGS)) continue;

    if (typeof DEFAULT_ARGS[name] === 'boolean') {
      args[name] = true;
      continue;
    }

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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const triggerPayload = loadJson(args.trigger);
  const branch = String(triggerPayload.branch || deriveAgentBranch(args.baseBranch, triggerPayload.issue_number, 1));
  const issueNumber = triggerPayload.issue_number ? Number(triggerPayload.issue_number) : null;
  const attempt = Number(args.attempt) || 1;
  const maxAttempts = Number(args.maxAttempts) || 3;

  const promptText = fs.readFileSync(args.prompt, 'utf8');
  const secrets = knownSecrets();

  /*
   * A missing CLI is a clear BLOCKED, not an unexplained spawn failure. It is
   * checked before the run so the report can say what is actually wrong.
   */
  if (!(await isOpenCodeAvailable())) {
    const payload = writeBlocked(
      args.out,
      `the opencode executable is not available on this runner, so the task could not be started.`,
      `Install OpenCode on the runner (npm install --global @opencode/cli@${args.version}) and re-run.`,
      { agent_exit_code: 127 }
    );
    return { exitCode: 1, payload };
  }

  // The agent may never be pointed at a protected branch.
  if (isProtectedBranch(branch)) {
    const payload = writeBlocked(
      args.out,
      `refusing to work on the protected branch "${branch}".`,
      'The control plane must always derive an agent branch.',
      { agent_exit_code: 126 }
    );
    return { exitCode: 1, payload };
  }

  const before = headSha();

  const result = await runOpenCode(promptText, {
    model: args.model,
    agent: args.agent,
    timeoutSeconds: Number(args.timeout) || DEFAULT_TIMEOUT_SECONDS,
    continueSession: args.continueSession,
  });

  const after = headSha();
  const files = dirtyFiles();
  const commits = lastCommitSummary(3);

  const suite = testSuitePassed();
  const commitCreated = Boolean(after) && after !== before;

  const push = commitCreated ? pushState(after, { ref: branch }) : PUSH_UNKNOWN;

  // The agent is expected to open the PR; verify it rather than trust it.
  let prState = PR_UNKNOWN;
  let pr = null;
  if (commitCreated && push === PUSH_PUSHED) {
    const github = new GitHub({
      repository: process.env.GITHUB_REPOSITORY || '',
      baseBranch: args.baseBranch,
    });

    pr = github.findPullRequest(branch);
    prState = pr ? (pr.isOpen ? PR_OPEN : PR_MISSING) : PR_MISSING;
  }

  const verdict = classifyTask({
    agentSucceeded: result.succeeded,
    startSha: before,
    headSha: after,
    dirtyFiles: files,
    pushState: push,
    prState,
    testsPassed: suite.passed,
    agentTimedOut: result.timedOut,
    branch,
  });

  // Wait for the checks that the pull request triggered.
  let checkRuns = [];
  let ciResult = describeCi(verdict, push, prState, after, branch, checkRuns);

  if (args.waitForCi && verdict.commitCreated && push === PUSH_PUSHED && prState === PR_OPEN) {
    const github = new GitHub({
      repository: process.env.GITHUB_REPOSITORY || '',
      baseBranch: args.baseBranch,
    });

    checkRuns = await waitForChecks(github, after);
    ciResult = summarizeChecks(checkRuns);

    if (checkRuns.some((run) => run.failed)) {
      const githubCli = new GitHub({
        repository: process.env.GITHUB_REPOSITORY || '',
        baseBranch: args.baseBranch,
      });
      const failing = checkRuns.find((run) => run.failed);
      const logs = githubCli.failedLogs(failing.runId);
      fs.writeFileSync('failure-evidence.log', redact(boundLog(logs), { secrets }), 'utf8');
    }
  }

  const filesChanged = commitCreated
    ? runCommand(['git', 'show', '--name-only', '--pretty=format:', after]).output.trim() || 'none recorded'
    : files.length
      ? files.join(', ')
      : 'no repository changes';

  const outcome = new TaskOutcome({
    status: verdict.status,
    reason: verdict.reason,
    commitSha: commitCreated ? after : '',
    branch,
    pullRequest: pr ? `#${pr.number}` : '',
    pullRequestUrl: pr ? pr.url : '',
    tests: suite.summary,
    checkRuns: 'see CI run',
    ciResult,
    recoveryAttempts: Math.max(0, attempt - 1),
    maxAttempts,
    filesChanged,
    summary: result.text || 'OpenCode produced no final message.',
    humanAction: verdict.humanAction,
  });

  const payload = {
    status: TASK_STATUSES.has(outcome.status) ? outcome.status : STATUS_FAILED,
    reason: verdict.reason,
    head_sha: after,
    branch,
    pushed: push === PUSH_PUSHED,
    commit_created: commitCreated,
    push_state: push,
    pr_state: prState,
    pull_request_number: pr ? pr.number : '',
    pull_request_url: pr ? pr.url : '',
    commits,
    agent_exit_code: result.exitCode,
    agent_session_id: result.sessionId,
    agent_text: outcome.summary,
    agent_timed_out: result.timedOut,
    tests: outcome.tests,
    tests_passed: suite.passed,
    check_runs: checkRuns.map((run) => ({
      id: run.runId,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
    })),
    ci_result: outcome.ciResult,
    files_changed: outcome.filesChanged,
    human_action: outcome.humanAction,
    recoverable: verdict.isRecoverable,
    version: args.version,
    model: args.model,
    agent: args.agent,
    attempt,
    max_attempts: maxAttempts,
  };

  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // A redacted copy of the raw streams for the artifact.
  const logDir = 'agent-logs';
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `stdout-${attempt}.log`), redact(result.stdout, { secrets }), 'utf8');
  fs.writeFileSync(path.join(logDir, `stderr-${attempt}.log`), redact(result.stderr, { secrets }), 'utf8');
  fs.writeFileSync(path.join(logDir, 'prompt.md'), promptText, 'utf8');

  console.log(`AGENT_STATUS=${outcome.status}`);
  console.log(`AGENT_REASON=${verdict.reason}`);
  console.log(`HEAD_SHA=${after}`);
  console.log(`BRANCH=${branch}`);
  console.log(`PUSHED=${push === PUSH_PUSHED}`);
  console.log(`PR_STATE=${prState}`);
  console.log(`CI_RESULT=${ciResult}`);
  console.log(`COMMITS=${commits}`);

  return { exitCode: outcome.isSuccess ? 0 : 1, payload };
}

function describeCi(verdict, push, prState, sha, branch, checkRuns) {
  if (checkRuns.length) return summarizeChecks(checkRuns);

  if (!verdict.commitCreated) {
    return 'no commit was created, so no CI could have been triggered; the repository is unchanged';
  }
  if (push === PUSH_NOT_PUSHED) {
    return `commit ${sha} is not on the remote branch, so CI was not triggered`;
  }
  if (push === PUSH_UNKNOWN) {
    return `the push of ${sha} could not be verified, so CI was not triggered`;
  }
  if (prState === PR_MISSING) {
    return `commit ${sha} was pushed to ${branch} but no pull request exists, so no CI ran against it`;
  }
  return 'CI has not been observed yet';
}

/*
 * Run only when executed directly, not when imported by a test.
 *
 * Compared through pathToFileURL rather than by string concatenation: on
 * Windows `import.meta.url` is `file:///C:/...` while `process.argv[1]` is
 * `C:\...`, so a hand-built `file://` prefix never matches and the CLI would
 * silently do nothing when run directly.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await main();
  process.exit(exitCode);
}
