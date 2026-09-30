#!/usr/bin/env node
/**
 * Create or reuse the deterministic agent branch, then check it out.
 *
 * Runs in its own job BEFORE the agent job's checkout, because checking out a
 * branch that does not exist is exactly the failure this prevents:
 *
 *     A branch or tag with the name 'agent/issue-main-2' could not be found
 *
 * The job deliberately checks out the BASE branch, which always exists, and
 * this script then makes the agent branch real. The result is published as a
 * step output so the agent job checks out a ref that is known to exist.
 *
 *     node src/agent/ensure-branch.mjs \
 *       --branch agent/issue-main-2 --base-branch main --issue-number 2
 *
 * Exit codes: 0 the branch is ready, 1 it is not. A non-zero exit fails the
 * job honestly rather than letting the agent start against a branch it cannot
 * use.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isProtectedBranch } from './events.mjs';
import { ensureAgentBranch } from './branch.mjs';

const DEFAULT_ARGS = {
  branch: '',
  baseBranch: 'main',
  issueNumber: '',
  remote: 'origin',
  resume: 'true',
};

function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;

    const name = key.slice(2).replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase());
    if (!(name in DEFAULT_ARGS)) continue;

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

function publish(outputFile, values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  fs.appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

export function main(argv = process.argv.slice(2), { outputFile = process.env.GITHUB_OUTPUT } = {}) {
  const args = parseArgs(argv);

  const branch = String(args.branch || '').trim();
  const baseBranch = String(args.baseBranch || 'main').trim();

  if (!branch) {
    console.error('BRANCH_MISSING=no agent branch was provided to bootstrap');
    return 1;
  }

  // Checked before touching git, and again inside planBranch. Cheap insurance
  // against a caller that passes a protected branch by mistake.
  if (isProtectedBranch(branch)) {
    console.error(`BRANCH_REFUSED="${branch}" is protected and can never be the agent working branch`);
    return 1;
  }

  const result = ensureAgentBranch({
    branch,
    baseBranch,
    remote: String(args.remote || 'origin'),
    issueNumber: Number.isFinite(Number(args.issueNumber)) && args.issueNumber !== ''
      ? Number(args.issueNumber)
      : null,
    resume: args.resume !== 'false',
  });

  if (!result.ok) {
    console.error(`BRANCH_BOOTSTRAP_FAILED=${result.reason}`);
    return 1;
  }

  if (outputFile) {
    publish(outputFile, {
      branch: result.branch,
      branch_action: result.action,
      bootstrap_head_sha: result.headSha,
    });
  }

  console.log(`BRANCH_READY=${result.branch}`);
  console.log(`BRANCH_ACTION=${result.action}`);
  console.log(`BOOTSTRAP_HEAD=${result.headSha}`);

  return 0;
}

/* Run only when executed directly, not when imported by a test. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
