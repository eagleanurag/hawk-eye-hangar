#!/usr/bin/env node
/**
 * Preflight: decide whether an event may run the agent, and write the
 * resolved trigger as JSON for later steps.
 *
 * Called by `.github/workflows/opencode-agent.yml`. Exits 0 when the agent
 * should run and 78 when the event must be ignored, so the calling step can
 * short-circuit without failing the workflow.
 *
 *     node src/agent/preflight.mjs \
 *       --event-file .agent/event.json \
 *       --owner "${{ github.repository_owner }}" \
 *       --out .agent/trigger.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXIT_ERROR,
  EXIT_IGNORED,
  EXIT_OK,
  TriggerRejected,
  authorizeCommentEvent,
  authorizeDispatchEvent,
  authorizeIssueEvent,
  deriveAgentBranch,
  isProtectedBranch,
} from './events.mjs';

// Re-exported so tests and callers can assert on the exit contract without
// importing the event vocabulary as well.
export { EXIT_ERROR, EXIT_IGNORED, EXIT_OK };

const DEFAULT_ARGS = {
  eventFile: '',
  eventName: '',
  actor: '',
  owner: '',
  issueNumber: '',
  title: '',
  bodyFile: '',
  task: '',
  contextFile: '',
  baseBranch: 'main',
  attempt: '1',
  out: 'trigger.json',
};

/**
 * Parse `--flag value` pairs into a camelCase argument object.
 *
 * The flag name is converted from kebab-case to camelCase rather than kept as
 * snake_case, because that is what the rest of this module reads. Getting this
 * wrong silently produces an empty argument, which is why the conversion is
 * done once, here, rather than at every use site.
 */
function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;

    const name = key
      .slice(2)
      .replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase());

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

function readText(pathname) {
  if (!pathname) return '';
  try {
    return fs.readFileSync(pathname, 'utf8');
  } catch {
    return '';
  }
}

/** An unreadable or malformed document is an empty mapping, so the
 * authorization functions deny rather than raise on missing data. */
function loadJson(pathname) {
  const text = readText(pathname);
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toIssueNumber(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolve(args) {
  const context = loadJson(args.contextFile);
  const payload = loadJson(args.eventFile);

  if (Object.keys(payload).length) {
    const eventName = String(payload.event || '');
    const actor = String(payload.actor || '');
    const title = String(payload.title || '');
    const body = String(payload.body || '');
    const task = String(payload.task || '');
    const issueNumber = toIssueNumber(payload.issue_number);
    const baseBranch = String(payload.base_branch || args.baseBranch || 'main');

    if (eventName === 'issues') {
      return authorizeIssueEvent({ actor, owner: args.owner, title, body, issueNumber, baseBranch });
    }

    if (eventName === 'issue_comment') {
      return authorizeCommentEvent({
        actor,
        owner: args.owner,
        body,
        issueNumber,
        originalTask: String(context.original_task || ''),
        issueTitle: String(context.issue_title || title || ''),
        priorComments: Array.isArray(context.prior_comments) ? context.prior_comments : [],
        baseBranch,
      });
    }

    if (eventName === 'workflow_dispatch') {
      return authorizeDispatchEvent({ actor, owner: args.owner, task, issueNumber, baseBranch });
    }

    throw new TriggerRejected(`unsupported event name: "${eventName}"`);
  }

  // Individual flags exist for local testing and are only consulted when no
  // event document was supplied.
  const body = readText(args.body_file);
  const issueNumber = toIssueNumber(args.issue_number);

  if (args.event_name === 'issues') {
    return authorizeIssueEvent({
      actor: args.actor,
      owner: args.owner,
      title: args.title,
      body,
      issueNumber,
      baseBranch: args.baseBranch,
    });
  }

  if (args.event_name === 'issue_comment') {
    return authorizeCommentEvent({
      actor: args.actor,
      owner: args.owner,
      body,
      issueNumber,
      originalTask: String(context.original_task || ''),
      issueTitle: String(context.issue_title || ''),
      priorComments: Array.isArray(context.prior_comments) ? context.prior_comments : [],
      baseBranch: args.baseBranch,
    });
  }

  if (args.event_name === 'workflow_dispatch') {
    return authorizeDispatchEvent({
      actor: args.actor,
      owner: args.owner,
      task: args.task,
      issueNumber,
      baseBranch: args.baseBranch,
    });
  }

  throw new TriggerRejected(`unsupported event name: "${args.event_name}"`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  let trigger;

  try {
    trigger = resolve(args);
  } catch (error) {
    if (error instanceof TriggerRejected) {
      console.log(`IGNORED: ${error.reason}`);
      console.log(JSON.stringify({ authorized: false, reason: error.reason }, null, 2));
      return EXIT_IGNORED;
    }

    console.error(`PREFLIGHT_ERROR=${error.message}`);
    return EXIT_ERROR;
  }

  const branch = deriveAgentBranch(trigger.baseBranch, trigger.issueNumber, Number(args.attempt) || 1);

  /*
   * The BASE branch is expected to be `main` — that is what the pull request
   * targets. The WORKING branch is the derived agent branch, and that is the
   * one that must never be a protected branch. Checking the base here would
   * reject every legitimate task, because main is the normal base.
   */
  if (isProtectedBranch(branch)) {
    console.log(`IGNORED: derived working branch "${branch}" is protected; refusing to run`);
    return EXIT_IGNORED;
  }

  const payload = { authorized: true, ...trigger.toJSON(), branch };

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`TRIGGER_KIND=${trigger.kind}`);
  console.log(`ISSUE_NUMBER=${trigger.issueNumber ?? ''}`);
  console.log(`ACTOR=${trigger.actor}`);
  console.log(`BRANCH=${branch}`);
  console.log(`TASK_SUMMARY=${trigger.summary}`);

  return EXIT_OK;
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
  process.exit(main());
}
