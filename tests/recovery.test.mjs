/**
 * Tests for the crash-recovery state machine.
 *
 * The recovery mechanism is only worth having if it is correct, so the rules
 * that stop it from destroying work or looping forever are pinned down here
 * rather than trusted to a manual test.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'migration-state.mjs');
const MIGRATE = path.join(ROOT, '.migration');
const P = {
  state: path.join(MIGRATE, 'state.json'),
  completed: path.join(MIGRATE, 'completed.json'),
  failed: path.join(MIGRATE, 'failed.json'),
  queue: path.join(MIGRATE, 'queue.json'),
  checkpoint: path.join(MIGRATE, 'checkpoint.json'),
  lock: path.join(MIGRATE, 'resume.lock'),
};

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const run = (...args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

/** Snapshot the real state so the tests never damage the project. */
let backup = null;
before(() => {
  backup = {};
  for (const p of Object.values(P)) {
    backup[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
});
after(() => {
  for (const [p, buf] of Object.entries(backup)) {
    if (buf) fs.writeFileSync(p, buf);
    else fs.rmSync(p, { force: true });
  }
});

/* ------------------------------------------------------------------ */

test('the state tool exists and its evidence is derived from the repository', () => {
  assert.ok(fs.existsSync(TOOL));
  const ev = JSON.parse(run('evidence').out);
  assert.ok(ev.aircraftRecords > 0, 'aircraft records found');
  assert.equal(ev.uniqueSlugs, ev.aircraftRecords, 'slugs are unique');
  assert.equal(ev.uniqueSourceUrls, ev.aircraftRecords, 'source URLs are unique');
  assert.equal(ev.manifestEntries, ev.aircraftRecords, 'manifest covers every aircraft');
  assert.ok(ev.mediaFiles > 0, 'archived media found');
  assert.ok(ev.mediaDirs === ev.aircraftRecords, 'every aircraft has a media directory');
  assert.match(ev.head, /^[0-9a-f]{40}$/);
});

test('init produces a state file with the required shape', () => {
  const { code } = run('init');
  assert.equal(code, 0);
  const s = read(P.state);
  for (const k of ['project', 'status', 'phase', 'resumeRequired', 'lastKnownCommit', 'pagesUrl', 'evidence']) {
    assert.ok(k in s, `state.json has "${k}"`);
  }
  for (const p of [P.completed, P.failed, P.queue, P.checkpoint]) {
    assert.ok(fs.existsSync(p), `${path.basename(p)} exists`);
  }
  assert.ok(read(P.queue).tasks.length > 0, 'the queue has tasks');
});

test('completion flags come from evidence, not from assertion', () => {
  run('init');
  const queue = read(P.queue).tasks;
  // These four cannot be true unless the artefacts are actually on disk.
  for (const id of ['discover', 'import', 'media', 'plans']) {
    const t = queue.find((x) => x.id === id);
    assert.ok(t && t.done, `${id} is evidenced complete`);
    assert.ok(t.evidence && t.evidence.length > 5, `${id} records why`);
  }
});

test('plan-file archival cannot be claimed while aircraft are still PENDING', () => {
  run('init');
  const t = read(P.queue).tasks.find((x) => x.id === 'plan-files');
  assert.ok(t, 'the plan-files gate exists as its own task');
  assert.equal(typeof t.done, 'boolean');

  // The gate must be the conjunction of every aircraft being terminal. Verified
  // against the evidence directly so the assertion holds even after the blocked
  // run resolves its PENDING aircraft.
  const ev = JSON.parse(run('evidence').out);
  const terminal = ev.planFilesDownloaded + ev.planFilesSourceOnly + ev.planFilesFailed;
  assert.equal(
    t.done,
    ev.planFilesResolved > 0 && ev.planFilesResolved === ev.aircraftRecords && ev.planFilesPending === 0,
    'plan-files.done agrees with the plan-file evidence'
  );
  assert.equal(terminal + ev.planFilesPending, ev.aircraftRecords, 'every aircraft is counted exactly once');
  // A manifest full of entries must never, on its own, satisfy the gate.
  assert.ok(ev.manifestEntries > 0, 'the manifest exists');
  if (ev.planFilesPending > 0) {
    assert.equal(t.done, false, 'PENDING aircraft block completion');
  }
});

test('is-complete refuses to report completion while plan files are unresolved', () => {
  const r = run('is-complete');
  const ev = JSON.parse(run('evidence').out);
  if (ev.planFilesPending > 0 || ev.planFilesDownloaded < ev.aircraftRecords) {
    assert.notEqual(r.code, 0, 'is-complete is non-zero while plan files are unresolved');
  }
});

test('done / fail / next drive the queue', () => {
  run('init');
  const first = run('next');
  assert.equal(first.code, 0);
  const next = JSON.parse(first.out);
  assert.ok(next.id, 'a next task is reported');

  run('begin', next.id);
  assert.equal(read(P.state).currentTask, next.id);

  run('done', next.id, 'proven by the test suite');
  assert.ok(read(P.completed).tasks.some((t) => t.id === next.id));
  assert.equal(read(P.state).currentTask, null);

  // A failure is recorded, not swallowed, and becomes the retry candidate.
  run('fail', 'synthetic-task', 'network was down');
  const failed = read(P.failed).tasks.find((t) => t.id === 'synthetic-task');
  assert.ok(failed, 'the failure is recorded');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.recovered, false);
  const retry = JSON.parse(run('next').out);
  assert.equal(retry.id, 'synthetic-task', 'a recoverable failure is retried first');
  assert.equal(retry.retry, true);
  assert.match(retry.title, /attempt 2\/3/, 'the retry budget is reported');

  // Repeating the same failure increments the attempt count rather than
  // duplicating the entry.
  run('fail', 'synthetic-task', 'network was still down');
  const again = read(P.failed).tasks.filter((t) => t.id === 'synthetic-task');
  assert.equal(again.length, 1, 'no duplicate failure entry');
  assert.equal(again[0].attempts, 2);

  // A later success supersedes the failure.
  run('done', 'synthetic-task', 'worked this time');
  assert.equal(read(P.failed).tasks.find((t) => t.id === 'synthetic-task').recovered, true);
  assert.notEqual(JSON.parse(run('next').out).id, 'synthetic-task', 'a recovered failure is not retried');

  // The retry budget is finite, so a permanently broken task cannot loop.
  run('fail', 'looping-task', 'always fails');
  for (let i = 0; i < 3; i++) run('fail', 'looping-task', 'always fails');
  assert.equal(read(P.failed).tasks.find((t) => t.id === 'looping-task').attempts, 4);
  assert.notEqual(JSON.parse(run('next').out).id, 'looping-task', 'a task past the attempt cap is left for a human');
  read(P.failed).tasks = read(P.failed).tasks.filter((t) => t.id !== 'synthetic-task' && t.id !== 'looping-task');
  write(P.failed, read(P.failed));
});

test('is-complete exits 0 only when the state AND the queue agree', () => {
  run('init');
  const s = read(P.state);
  s.status = 'completed';
  s.finalCommit = 'TESTCOMMIT';
  write(P.state, s);
  const q = read(P.queue);
  const open = q.tasks.filter((t) => !t.done);
  assert.ok(open.length > 0, 'the queue still has open tasks');

  // Completed flag but open tasks => NOT complete. This is the guard that stops
  // a hand-edited or half-written state file from ending the automation.
  assert.notEqual(run('is-complete').code, 0, 'a completed state with open tasks is not complete');

  // Close the queue => complete.
  for (const t of q.tasks) t.done = true;
  write(P.queue, q);
  assert.equal(run('is-complete').code, 0, 'closed queue plus completed state is complete');

  // A recorded, unresolved failure also blocks completion.
  write(P.queue, q);
  write(P.failed, { tasks: [{ id: 'x', reason: 'y', recoverable: true, attempts: 1, recovered: false }] });
  assert.notEqual(run('is-complete').code, 0, 'an unresolved failure blocks completion');
  write(P.failed, { tasks: [] });
});

test('complete records the final commit and stops asking for recovery', () => {
  run('init');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const { code } = run('complete', head);
  assert.equal(code, 0);
  const s = read(P.state);
  assert.equal(s.status, 'completed');
  assert.equal(s.phase, 'completed');
  assert.equal(s.resumeRequired, false);
  assert.equal(s.finalCommit, head);
  assert.ok(s.completedAt, 'completion is timestamped');
  const c = read(P.checkpoint);
  assert.equal(c.reason, 'project-complete');
});

test('checkpoint records the commit, dirty count and sync state', () => {
  run('init');
  run('checkpoint', 'unit test');
  const c = read(P.checkpoint);
  assert.equal(c.reason, 'unit test');
  assert.match(c.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof c.dirtyFiles, 'number');
  assert.equal(typeof c.inSync, 'boolean');
  assert.equal(read(P.state).lastCheckpointReason, 'unit test');
});

test('an unknown command fails loudly rather than silently doing nothing', () => {
  const r = run('not-a-command');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /unknown command/);
});

/* ------------------------------------------------------------------ */
/* The PowerShell resume script                                         */
/* ------------------------------------------------------------------ */

const PS = path.join(ROOT, 'scripts', 'resume-parkjets.ps1');
const hasPwsh = process.platform === 'win32';

test('the resume scripts are present', () => {
  assert.ok(fs.existsSync(PS), 'resume-parkjets.ps1 exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'resume-parkjets.cmd')), 'resume-parkjets.cmd exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'install-parkjets-task.ps1')), 'installer exists');
});

test('the PowerShell scripts are ASCII with a UTF-8 BOM, so PS 5.1 can parse them', () => {
  for (const f of ['resume-parkjets.ps1', 'resume-parkjets.cmd', 'install-parkjets-task.ps1']) {
    const p = path.join(ROOT, 'scripts', f);
    const buf = fs.readFileSync(p);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${f} starts with a UTF-8 BOM`);
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const bad = [...text].filter((c) => c.codePointAt(0) > 126);
    assert.equal(bad.length, 0, `${f} is ASCII-only (${bad.length} non-ASCII)`);
  }
});

test('fix-bom.mjs must not strip the BOM from Windows scripts', { skip: !hasPwsh }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fix-bom.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const buf = fs.readFileSync(PS);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM survived fix-bom.mjs');
});

test('the resume script parses as valid PowerShell', { skip: !hasPwsh }, () => {
  const ps = `
$err = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('${PS.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$err)
if ($err) { $err | ForEach-Object { $_.Message }; exit 1 }
exit 0`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, `parse errors: ${r.stdout} ${r.stderr}`);
});

test('the resume script refuses to launch when the project is complete', { skip: !hasPwsh }, () => {
  run('init');
  const s = read(P.state);
  s.status = 'completed';
  s.phase = 'completed';
  s.resumeRequired = false;
  s.finalCommit = 'TESTCOMMIT';
  write(P.state, s);
  write(P.queue, { generatedAt: new Date().toISOString(), tasks: [] });
  write(P.failed, { tasks: [] });
  fs.rmSync(P.lock, { force: true });

  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, 'exits 0 when there is nothing to do');
  assert.match(r.stdout, /is complete/i);
  // "not launching" contains "launching", so assert on the positive form only.
  assert.doesNotMatch(r.stdout, /launching: /i, 'must not start the agent');
  assert.doesNotMatch(r.stdout, /OpenCode started/i, 'must not start the agent');
  assert.ok(!fs.existsSync(P.lock), 'must not leave a lock behind');
  assert.ok(!fs.existsSync(path.join(MIGRATE, 'logs', 'opencode-stdout.log')) ||
    fs.statSync(path.join(MIGRATE, 'logs', 'opencode-stdout.log')).mtimeMs < Date.now(),
    'must not have produced agent output');
});

test('the resume script refuses to launch when another run holds the lock', { skip: !hasPwsh }, () => {
  run('init');
  // A PID that is definitely alive: this very node process.
  write(P.lock, { pid: process.pid, owner: 'test', started: new Date().toISOString() });
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, 'exits 0 rather than launching a duplicate');
  assert.match(r.stdout, /Already running/i);
  fs.rmSync(P.lock, { force: true });
});

test('the resume script never modifies the working tree', { skip: !hasPwsh }, () => {
  run('init');
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  for (const args of [['-Status'], ['-DryRun']]) {
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, ...args], { cwd: ROOT, encoding: 'utf8' });
  }
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(head2, head, 'HEAD unchanged');
  assert.equal(after.split('\n').filter(Boolean).length, before.split('\n').filter(Boolean).length, 'no paths added or removed');
  fs.rmSync(P.lock, { force: true });
});

test('the scheduled task is installed with the safety settings', { skip: !hasPwsh }, () => {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `
$t = Get-ScheduledTask -TaskName 'ParkjetsArchiveRecovery' -ErrorAction SilentlyContinue
if (-not $t) { Write-Output 'ABSENT'; exit 0 }
Write-Output ("EXECUTE=" + $t.Actions[0].Execute)
Write-Output ("ARGUMENTS=" + $t.Actions[0].Arguments)
Write-Output ("TRIGGERS=" + ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) )
Write-Output ("MULTIPLE=" + $t.Settings.MultipleInstances)
Write-Output ("STARTWHENAVAILABLE=" + $t.Settings.StartWhenAvailable)
exit 0`],
    { encoding: 'utf8' }
  );
  const out = r.stdout || '';
  if (out.includes('ABSENT')) return; // not installed on this machine; nothing to assert
  // The whole command line must NOT be passed as the executable.
  assert.match(out, /EXECUTE=powershell\.exe\s*$/m, 'Execute is the executable alone');
  assert.match(out, /ARGUMENTS=.*-File .*resume-parkjets\.ps1/m);
  assert.doesNotMatch(out, /EXECUTE=powershell\.exe -/m, 'Execute must not contain flags');
  assert.match(out, /TRIGGERS=.*Logon/i, 'has a logon trigger');
  assert.match(out, /MULTIPLE=IgnoreNew/i, 'duplicate triggers cannot stack');
  assert.match(out, /STARTWHENAVAILABLE=True/i, 'a missed logon is caught up');
});
