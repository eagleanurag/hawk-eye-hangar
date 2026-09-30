/**
 * Tests for the optional external Git credential path.
 *
 * These tests never contain a real credential. They verify that the token is
 * read only from the environment, the askpass helper itself contains no
 * token, the built-in GitHub token path stays untouched when the secret is
 * absent, and the workflow wires the repository secret without exposing it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  armPushAuthentication,
  credentialArmed,
  credentialDescription,
  isWorkflowPushRejection,
  pushEnvironment,
  resolvePushToken,
} from '../src/agent/credentials.mjs';
import {
  DEFAULT_STARTUP_TIMEOUT_SECONDS,
  buildCommand,
  timeoutMilliseconds,
} from '../src/agent/opencode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'opencode-agent.yml');

function initGitRepository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-credentials-'));
  execFileSync('git', ['init', '--quiet', directory], { stdio: 'ignore' });
  return directory;
}

test('missing external credential leaves the built-in authentication path unchanged', () => {
  const logs = [];
  const authentication = armPushAuthentication({
    repositoryRoot: process.cwd(),
    environ: {},
    log: (message) => logs.push(message),
  });

  assert.equal(authentication.configured, false);
  assert.equal(authentication.helperPath, '');
  assert.match(authentication.reason, /not configured/i);
  assert.equal(resolvePushToken({}), '');
  assert.equal(credentialArmed({}), false);
  assert.match(credentialDescription({}), /built-in GITHUB_TOKEN/i);
  assert.equal(pushEnvironment(authentication, { GITHUB_TOKEN: 'present' }).GITHUB_TOKEN, 'present');
  assert.ok(logs.length >= 1);
});

test('the external credential is armed without writing the token into the askpass helper', () => {
  const directory = initGitRepository();
  const secret = 'repository-secret-value-12345678';

  try {
    execFileSync(
      'git',
      ['config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: bearer builtin'],
      { cwd: directory, stdio: 'ignore' }
    );

    const authentication = armPushAuthentication({
      repositoryRoot: directory,
      environ: {
        AGENT_PUSH_TOKEN: secret,
        AGENT_CREDENTIAL_ARMED: 'true',
      },
    });

    assert.equal(authentication.configured, true);
    assert.ok(authentication.helperPath);
    assert.equal(fs.existsSync(authentication.helperPath), true);

    const helper = fs.readFileSync(authentication.helperPath, 'utf8');
    assert.doesNotMatch(helper, new RegExp(secret));
    assert.match(helper, /AGENT_PUSH_TOKEN/);

    assert.equal(credentialArmed({ AGENT_CREDENTIAL_ARMED: 'true' }), true);
    const environment = pushEnvironment(authentication, { PATH: '/usr/bin' });
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
    assert.equal(environment.GIT_ASKPASS, authentication.helperPath);
    assert.equal(environment.AGENT_PUSH_TOKEN, undefined);

    const remainingHeader = execFileSync(
      'git',
      ['config', '--local', '--get-all', 'http.https://github.com/.extraheader'],
      { cwd: directory, encoding: 'utf8' }
    );
    assert.equal(remainingHeader.trim(), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow push rejections are recognized without embedding a credential', () => {
  assert.equal(
    isWorkflowPushRejection(
      'remote: refusing to allow a GitHub App to create or update workflow without workflows permission'
    ),
    true
  );
  assert.equal(isWorkflowPushRejection('remote: permission denied'), false);
});

test('the workflow exposes the optional repository secret only to the agent step', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

  assert.match(workflow, /AGENT_PUSH_TOKEN: \$\{\{ secrets\.OPENCODE_AGENT_TOKEN \}\}/);
  assert.match(workflow, /AGENT_CREDENTIAL_ARMED: \$\{\{ secrets\.OPENCODE_AGENT_TOKEN != '' \}\}/);
  assert.doesNotMatch(workflow, /OPENCODE_AGENT_TOKEN:[^\n]*['"][A-Za-z0-9]/);
  assert.match(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /workflows:\s*write/);
});

test('OpenCode logs are available in the captured child stream', () => {
  const command = buildCommand('smoke');
  assert.ok(command.includes('--print-logs'));
});

test('startup timeout is bounded independently from the long task timeout', () => {
  assert.equal(DEFAULT_STARTUP_TIMEOUT_SECONDS, 120);
  assert.equal(timeoutMilliseconds(DEFAULT_STARTUP_TIMEOUT_SECONDS), 120000);
});
