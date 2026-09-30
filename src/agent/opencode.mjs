/**
 * Running OpenCode and capturing its output.
 *
 * The CLI is invoked non-interactively with `opencode run`, JSON output and
 * auto-approve, so the agent can read, edit and run commands with no human at
 * the keyboard. The version is pinned rather than tracking latest, so a
 * control-plane run cannot break because of an upstream CLI change.
 */

import { spawn } from 'node:child_process';

export const DEFAULT_VERSION = '2.0.20';
export const DEFAULT_MODEL = 'opencode/space-bunny-free';
export const DEFAULT_AGENT = 'remote-engineer';
export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 120;

/** Convert the public timeout unit (seconds) to the timer unit (milliseconds). */
export function timeoutMilliseconds(timeoutSeconds) {
  const seconds = Number(timeoutSeconds);
  return Math.max(1, Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_TIMEOUT_SECONDS * 1000);
}

const EXIT_TIMEOUT = 124;

export class OpenCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenCodeError';
  }
}

export class OpenCodeResult {
  constructor({ text, sessionId, exitCode, stdout, stderr, timedOut = false, startupTimedOut = false }) {
    this.text = text;
    this.sessionId = sessionId;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
    this.startupTimedOut = startupTimedOut;
  }

  get succeeded() {
    return this.exitCode === 0 && !this.timedOut;
  }
}

/**
 * Build the argv for a non-interactive run.
 *
 * The prompt is passed as a single argv element with `shell: false`, so
 * untrusted task text is never re-interpreted by a shell.
 */
export function buildCommand(prompt, options = {}) {
  const {
    executable = 'opencode',
    model = DEFAULT_MODEL,
    agent = DEFAULT_AGENT,
    continueSession = false,
  } = options;

  const command = [
    executable,
    'run',
    '--standalone',
    '--auto',
    '--format',
    'json',
    '--print-logs',
    '--model',
    model,
    '--agent',
    agent,
  ];

  if (continueSession) command.push('--continue');

  command.push(prompt);

  return command;
}

/**
 * Build the child environment.
 *
 * Auto-update is disabled so a runner cannot mutate its own toolchain
 * mid-task, and an ambient prompt variable is removed so no unrelated
 * environment value can be read as a task instruction.
 */
export function buildEnvironment(env = process.env) {
  const environment = { ...env };

  environment.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
  // The project must not reach a local service or a user config on the runner.
  environment.OPENCODE_DISABLE_PROJECT_CONFIG = '0';

  delete environment.OPENCODE_PROMPT;

  return environment;
}

/** Execute one OpenCode run and capture everything. */
export function runOpenCode(prompt, options = {}) {
  const {
    executable = 'opencode',
    model = DEFAULT_MODEL,
    agent = DEFAULT_AGENT,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    startupTimeoutSeconds = DEFAULT_STARTUP_TIMEOUT_SECONDS,
    cwd = process.cwd(),
    env = process.env,
    continueSession = false,
  } = options;

  const command = buildCommand(prompt, { executable, model, agent, continueSession });

  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env: buildEnvironment(env),
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve(
        new OpenCodeResult({
          text: '',
          sessionId: null,
          exitCode: 127,
          stdout: '',
          stderr: `Could not start ${command[0]}: ${error.message}`,
        })
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let startupObserved = false;

    const finishTimeout = (startupTimedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startupTimer);
      child.kill('SIGKILL');
      resolve(
        new OpenCodeResult({
          text: extractFinalText(stdout),
          sessionId: extractSessionId(stdout),
          exitCode: EXIT_TIMEOUT,
          stdout,
          stderr,
          timedOut: true,
          startupTimedOut,
        })
      );
    };

    const timer = setTimeout(() => finishTimeout(false), timeoutMilliseconds(timeoutSeconds));

    const startupTimer = setTimeout(() => {
      if (!startupObserved) finishTimeout(true);
    }, timeoutMilliseconds(startupTimeoutSeconds));

    const markStartupObserved = () => {
      if (startupObserved) return;
      startupObserved = true;
      clearTimeout(startupTimer);
    };

    child.stdout.on('data', (chunk) => {
      markStartupObserved();
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      markStartupObserved();
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startupTimer);
      resolve(
        new OpenCodeResult({
          text: '',
          sessionId: null,
          exitCode: 127,
          stdout,
          stderr: `${stderr}\nCould not start ${command[0]}: ${error.message}`,
        })
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startupTimer);
      resolve(
        new OpenCodeResult({
          text: extractFinalText(stdout),
          sessionId: extractSessionId(stdout),
          exitCode: code === null ? EXIT_TIMEOUT : code,
          stdout,
          stderr,
        })
      );
    });
  });
}

/**
 * Pull the last text block out of an OpenCode JSON event stream.
 *
 * OpenCode emits newline-delimited JSON events. Anything that does not parse
 * is ignored, so a stray log line cannot break parsing.
 */
export function extractFinalText(output) {
  const texts = [];

  for (const line of String(output || '').split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;

    let event;
    try {
      event = JSON.parse(stripped);
    } catch {
      continue;
    }

    if (!event || event.type !== 'text') continue;

    const part = event.part;
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text.trim());
  }

  return texts.length ? texts[texts.length - 1] : '';
}

/** Find the first session id present in an event stream. */
export function extractSessionId(output) {
  for (const line of String(output || '').split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;

    let event;
    try {
      event = JSON.parse(stripped);
    } catch {
      continue;
    }

    if (event && typeof event.sessionID === 'string' && event.sessionID) return event.sessionID;
  }

  return null;
}

/**
 * Whether the opencode executable can be located.
 *
 * Reported separately so a missing CLI is a clear BLOCKED result rather than
 * an unexplained spawn failure.
 */
export async function isOpenCodeAvailable(executable = 'opencode') {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], {
      shell: false,
      windowsHide: true,
    });

    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && /opencode/i.test(out)));
  });
}

/** Location of the coding agent definition. */
export function agentFilePath(repositoryRoot, agent = DEFAULT_AGENT) {
  return `${String(repositoryRoot).replace(/[/\\]+$/, '')}/.opencode/agents/${agent}.md`;
}
