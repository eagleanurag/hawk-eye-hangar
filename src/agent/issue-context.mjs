#!/usr/bin/env node
/**
 * Assemble continuation context for an `issue_comment` event.
 *
 * Pulls the original task and the most recent comments from the issue,
 * truncates them, and writes a JSON file the preflight step consumes.
 * Fetching is bounded: only the newest page is requested and each entry is
 * length-capped before being written.
 *
 *     node src/agent/issue-context.mjs --issue 42 --out context.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  MAX_COMMENT_CHARACTERS,
  MAX_ISSUE_TITLE_CHARACTERS,
  MAX_TASK_CHARACTERS,
  buildPriorContext,
  truncate,
} from './events.mjs';

function ghJson(arguments_, repository) {
  const command = ['gh', ...arguments_];
  if (repository) command.push('--repo', repository);

  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(String(stdout || 'null'));
  } catch (error) {
    console.error(
      `CONTEXT_FETCH_FAILED=${String(error.stderr || error.message).trim().slice(0, 500)}`
    );
    return null;
  }
}

export function fetchIssueContext(issue, { limit = 20, repository = '' } = {}) {
  const issuePayload = ghJson(
    ['issue', 'view', String(issue), '--json', 'title,body'],
    repository
  );

  const commentsPayload = ghJson(
    ['issue', 'view', String(issue), '--json', 'comments', '--comments', String(Math.max(1, limit))],
    repository
  );

  let title = '';
  let body = '';

  if (issuePayload && typeof issuePayload === 'object') {
    title = String(issuePayload.title || '');
    body = String(issuePayload.body || '');
  }

  const comments = [];

  if (commentsPayload && typeof commentsPayload === 'object' && Array.isArray(commentsPayload.comments)) {
    for (const entry of commentsPayload.comments) {
      if (!entry || typeof entry !== 'object') continue;
      const text = String(entry.body || '');
      if (text.trim()) comments.push(truncate(text, MAX_COMMENT_CHARACTERS));
    }
  }

  return {
    issue_title: truncate(title, MAX_ISSUE_TITLE_CHARACTERS),
    original_task: truncate(body, MAX_TASK_CHARACTERS),
    prior_comments: comments,
    prior_context: buildPriorContext(comments),
  };
}

function parseArgs(argv) {
  const args = { issue: '', out: '', limit: '20', repository: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
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

  const payload = fetchIssueContext(args.issue, {
    limit: Number(args.limit) || 20,
    repository: args.repository,
  });

  fs.mkdirSync(path.dirname(path.resolve(args.out || '.')), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`CONTEXT_COMMENTS=${payload.prior_comments.length}`);

  return 0;
}

/* Run only when executed directly, not when imported by a test. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
