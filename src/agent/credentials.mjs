/**
 * Optional external repository credential for Git pushes.
 *
 * GitHub's built-in GITHUB_TOKEN is an installation token. When GitHub refuses
 * a ref update because it creates or updates a file under .github/workflows/,
 * no workflow permissions entry can grant that missing Workflows permission.
 *
 * The external PAT is therefore optional and used only for git authentication.
 * The secret value lives only in the process environment. Git asks a helper
 * script for the credential at push time; the helper itself contains no secret.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PUSH_TOKEN_ENV = 'AGENT_PUSH_TOKEN';
export const CREDENTIAL_ARMED_ENV = 'AGENT_CREDENTIAL_ARMED';
export const GIT_ASKPASS_ENV = 'GIT_ASKPASS';
export const GIT_TERMINAL_PROMPT_ENV = 'GIT_TERMINAL_PROMPT';

const CHECKOUT_EXTRAHEADER = 'http.https://github.com/.extraheader';

const ASKPASS_SCRIPT = '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\' \'x-access-token\' ;;\n  *) printf \'%s\' "$AGENT_PUSH_TOKEN" ;;\nesac\n';

export function resolvePushToken(environ = process.env) {
  return String(environ[PUSH_TOKEN_ENV] || '').trim();
}

export function credentialArmed(environ = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(environ[CREDENTIAL_ARMED_ENV] || '').trim().toLowerCase()
  );
}

export function credentialDescription(environ = process.env) {
  return credentialArmed(environ)
    ? 'external repository credential configured for git via askpass'
    : 'no external repository credential configured; built-in GITHUB_TOKEN remains active';
}

export function armPushAuthentication({
  repositoryRoot = process.cwd(),
  environ = process.env,
  log = () => {},
} = {}) {
  const tokenPresent = Boolean(resolvePushToken(environ));

  if (!tokenPresent) {
    log(credentialDescription(environ));
    return { configured: false, helperPath: '', reason: 'secret is not configured' };
  }

  const gitDir = absoluteGitDir(repositoryRoot);

  if (!gitDir) {
    log('external credential was configured, but this run is not inside a git checkout');
    return {
      configured: false,
      helperPath: '',
      reason: 'git directory could not be resolved',
    };
  }

  const helperPath = path.join(gitDir, 'askpass-agent.sh');

  try {
    fs.writeFileSync(helperPath, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700 });
    // actions/checkout normally installs its GITHUB_TOKEN as an extraheader.
    // Remove that header only when the external credential is actually present.
    try {
      execFileSync(
        'git',
        ['config', '--local', '--unset-all', CHECKOUT_EXTRAHEADER],
        {
          cwd: repositoryRoot,
          stdio: 'ignore',
        }
      );
    } catch {
      // No checkout extraheader is also a valid state.
    }
  } catch (error) {
    log('external credential could not be armed because the git askpass helper could not be prepared');
    return {
      configured: false,
      helperPath: '',
      reason: `askpass setup failed: ${error.message}`,
    };
  }

  log('external repository credential armed for git via askpass');
  return { configured: true, helperPath, reason: '' };
}

export function pushEnvironment(authentication, environ = {}) {
  const result = { ...environ };

  // Never expose the PAT to the model process unless the control plane is
  // explicitly performing the fallback Git push.
  if (!authentication?.configured) {
    delete result[PUSH_TOKEN_ENV];
    delete result[GIT_ASKPASS_ENV];
    return result;
  }

  result[GIT_ASKPASS_ENV] = authentication.helperPath;
  result[GIT_TERMINAL_PROMPT_ENV] = '0';
  return result;
}

/** Push exactly the current HEAD to the named agent branch with the external credential. */
export function pushCommitWithAuthentication(
  branch,
  authentication,
  { repositoryRoot = process.cwd(), environ = process.env } = {}
) {
  if (!authentication?.configured) {
    return { succeeded: false, reason: 'external credential is not configured' };
  }

  const environment = pushEnvironment(authentication, environ);

  try {
    execFileSync(
      'git',
      ['push', '--no-force', 'origin', `HEAD:refs/heads/${branch}`],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    return { succeeded: true, reason: '' };
  } catch {
    return { succeeded: false, reason: 'external credential push failed' };
  } finally {
    if (authentication.helperPath) {
      try {
        fs.rmSync(authentication.helperPath, { force: true });
      } catch {
        // The runner's disposable git directory is the final cleanup boundary.
      }
    }
  }
}

export function isWorkflowPushRejection(output) {
  const text = String(output || '').toLowerCase();
  return (
    text.includes('refusing to allow a github app to create or update workflow') ||
    (text.includes('create or update workflow') && text.includes('workflows` permission'))
  );
}

export function workflowPushRemedy() {
  return (
    'GitHub refused the push because the built-in GITHUB_TOKEN lacks the GitHub App ' +
    'Workflows repository permission. Configure the repository secret OPENCODE_AGENT_TOKEN ' +
    'with the repository-scoped fine-grained PAT, then re-run the task. The token value ' +
    'must never be pasted into chat, source, workflow text, logs or issue comments.'
  );
}

function absoluteGitDir(repositoryRoot) {
  try {
    const output = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return output && path.isAbsolute(output) ? output : '';
  } catch {
    return '';
  }
}
