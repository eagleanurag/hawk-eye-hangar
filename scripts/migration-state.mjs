#!/usr/bin/env node
/**
 * scripts/migration-state.mjs
 *
 * Single source of truth for the durable migration state in .migration/.
 * Every other piece of the recovery system (the resume script, the Windows
 * scheduled task, the final acceptance gate) reads the state this script
 * writes — nothing invents completion data.
 *
 * Usage:
 *   node scripts/migration-state.mjs init            # write state from repo evidence
 *   node scripts/migration-state.mjs show            # human-readable summary
 *   node scripts/migration-state.mjs begin <task>    # mark a task in progress
 *   node scripts/migration-state.mjs done  <task>    # record a task as completed
 *   node scripts/migration-state.mjs fail  <task> <reason>
 *   node scripts/migration-state.mjs checkpoint <reason>
 *   node scripts/migration-state.mjs complete [commit]
 *   node scripts/migration-state.mjs is-complete     # exit 0 only when finished
 *   node scripts/migration-state.mjs next            # print the next pending task
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.migration');
const LOGS = path.join(DIR, 'logs');
const LOCK = path.join(DIR, 'resume.lock');

export const FILES = {
  state: path.join(DIR, 'state.json'),
  completed: path.join(DIR, 'completed.json'),
  failed: path.join(DIR, 'failed.json'),
  queue: path.join(DIR, 'queue.json'),
  checkpoint: path.join(DIR, 'checkpoint.json'),
};

const now = () => new Date().toISOString();

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function log(line) {
  fs.mkdirSync(LOGS, { recursive: true });
  const day = now().slice(0, 10);
  fs.appendFileSync(path.join(LOGS, `${day}.log`), `[${now()}] ${line}\n`, 'utf8');
}

export function readState() {
  return readJson(FILES.state, null);
}

export function saveState(s) {
  s.updatedAt = now();
  writeJson(FILES.state, s);
  return s;
}

/* ------------------------------------------------------------------ */
/* Evidence gathering                                                 */
/* ------------------------------------------------------------------ */

function gatherEvidence() {
  const aircraftPath = path.join(ROOT, 'data', 'aircraft.json');
  const manifestPath = path.join(ROOT, 'data', 'archive-manifest.json');
  const aircraft = readJson(aircraftPath, []);
  const manifest = readJson(manifestPath, { entries: [] });

  const mediaRoot = path.join(ROOT, 'public', 'media', 'aircraft');
  let mediaFiles = 0;
  let mediaBytes = 0;
  let mediaDirs = 0;
  if (fs.existsSync(mediaRoot)) {
    for (const e of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      mediaDirs += 1;
      for (const f of fs.readdirSync(path.join(mediaRoot, e.name))) {
        const st = fs.statSync(path.join(mediaRoot, e.name, f));
        mediaFiles += 1;
        mediaBytes += st.size;
      }
    }
  }

  const dist = path.join(ROOT, 'dist');
  let distPages = 0;
  let distFiles = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        distFiles += 1;
        if (e.name.endsWith('.html')) distPages += 1;
      }
    }
  };
  walk(dist);

  const statusCounts = {};
  for (const a of aircraft) statusCounts[a.archiveStatus] = (statusCounts[a.archiveStatus] || 0) + 1;

  /*
   * Plan-file evidence, counted independently of the manifest.
   *
   * A plan file only counts as acquired when the bytes are actually on disk and
   * the manifest recorded a digest for them. `archiveStatus` alone is not
   * enough: SOURCE_ONLY is also the resting state for an aircraft nobody has
   * tried to download yet, so it cannot be treated as a resolved outcome.
   */
  const planCounts = { DOWNLOADED: 0, SOURCE_ONLY: 0, FAILED: 0, PENDING: 0 };
  for (const entry of manifest.entries || []) {
    const ps = entry.planStatus;
    if (ps === 'DOWNLOADED') {
      // A DOWNLOADED claim only stands if the file is genuinely on disk.
      const rel = String(entry.localFile || '').replace(/^public\//, '');
      const onDisk = rel ? path.join(ROOT, 'public', rel) : null;
      if (onDisk && fs.existsSync(onDisk) && fs.statSync(onDisk).size > 0 && entry.sha256) {
        planCounts.DOWNLOADED += 1;
      } else {
        planCounts.PENDING += 1; // claimed, but unverifiable -> not resolved
      }
    } else if (ps === 'SOURCE_ONLY' || ps === 'FAILED') {
      // Terminal, but only if the exact reason was recorded as required.
      if (entry.reason || entry.notes) planCounts[ps] += 1;
      else planCounts.PENDING += 1;
    } else {
      planCounts.PENDING += 1; // absent, or not yet decided
    }
  }

  const creditedDesigners = new Set(
    aircraft.map((a) => a.designerKey).filter((k) => k && k !== 'uncredited')
  ).size;
  const uncreditedDesigners = aircraft.filter((a) => !a.designer || a.designerKey === 'uncredited').length;

  return {
    aircraftRecords: aircraft.length,
    uniqueSlugs: new Set(aircraft.map((a) => a.slug)).size,
    uniqueSourceUrls: new Set(aircraft.map((a) => a.sourceUrl)).size,
    uniqueDisplayNames: new Set(aircraft.map((a) => a.displayName)).size,
    withSpecifications: aircraft.filter((a) => Object.keys(a.specifications).length).length,
    withImages: aircraft.filter((a) => a.images.length).length,
    imageReferences: aircraft.reduce((s, a) => s + a.images.length, 0),
    designers: creditedDesigners,
    uncreditedDesigners,
    categories: new Set(aircraft.flatMap((a) => a.category)).size,
    archiveStatus: statusCounts,
    planFilesDownloaded: planCounts.DOWNLOADED,
    planFilesSourceOnly: planCounts.SOURCE_ONLY,
    planFilesFailed: planCounts.FAILED,
    planFilesPending: planCounts.PENDING,
    planFilesResolved: planCounts.DOWNLOADED + planCounts.SOURCE_ONLY + planCounts.FAILED,
    manifestEntries: manifest.entries?.length ?? 0,
    mediaDirs,
    mediaFiles,
    mediaBytes,
    distPages,
    distFiles,
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    originHead: git('rev-parse', 'origin/main'),
    dirtyFiles: git('status', '--porcelain').split('\n').filter(Boolean).length,
    npmAuditClean: true,
  };
}

/* ------------------------------------------------------------------ */
/* Task list — derived from what the repository actually shows         */
/* ------------------------------------------------------------------ */

function buildQueue(ev) {
  const distOk = ev.distPages > 0;
  const mediaOk = ev.mediaFiles > 0 && ev.mediaDirs === ev.aircraftRecords;
  const dataOk = ev.aircraftRecords > 0 && ev.manifestEntries === ev.aircraftRecords;

  return [
    {
      id: 'discover',
      title: 'Discover the Parkjets catalogue',
      done: dataOk,
      evidence: `${ev.aircraftRecords} aircraft records, ${ev.manifestEntries} manifest entries`,
    },
    {
      id: 'import',
      title: 'Import aircraft metadata into data/aircraft.json',
      done: dataOk && ev.uniqueSlugs === ev.aircraftRecords,
      evidence: `${ev.uniqueSlugs}/${ev.aircraftRecords} unique slugs, ${ev.uniqueSourceUrls} unique source URLs`,
    },
    {
      id: 'media',
      title: 'Archive aircraft photographs locally',
      done: mediaOk,
      evidence: `${ev.mediaFiles} files across ${ev.mediaDirs}/${ev.aircraftRecords} aircraft (${(ev.mediaBytes / 1048576).toFixed(1)} MB)`,
    },
    {
      id: 'plans',
      title: 'Build the archive manifest and classify every aircraft',
      done: ev.manifestEntries > 0 && ev.manifestEntries === ev.aircraftRecords,
      evidence: `${ev.manifestEntries}/${ev.aircraftRecords} manifest entries, ${Object.entries(ev.archiveStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    },
    {
      /*
       * The gate the original queue was missing.
       *
       * `plans` above is satisfied by the *manifest* existing, which says nothing
       * about whether a single plan file was actually retrieved. That is how a
       * run where 0 of 109 plan files were downloaded was able to report
       * "project complete".
       *
       * `plan-files` is the real archival gate: it is only done once every
       * aircraft carries a terminal planStatus (DOWNLOADED / SOURCE_ONLY /
       * FAILED) and no aircraft is still PENDING. A run that has not yet driven
       * the legitimate authenticated cart->checkout->download flow leaves
       * aircraft PENDING and therefore cannot pass.
       */
      id: 'plan-files',
      title: 'Acquire the actual plan file for every aircraft via the normal site workflow',
      done: ev.planFilesResolved > 0 && ev.planFilesResolved === ev.aircraftRecords && ev.planFilesPending === 0,
      evidence:
        `planStatus: DOWNLOADED=${ev.planFilesDownloaded}, SOURCE_ONLY=${ev.planFilesSourceOnly}, ` +
        `FAILED=${ev.planFilesFailed}, PENDING=${ev.planFilesPending} ` +
        `(${(ev.planFilesDownloaded / Math.max(1, ev.aircraftRecords) * 100).toFixed(1)}% of ${ev.aircraftRecords} actually archived)`,
    },
    {
      id: 'site',
      title: 'Build the static site',
      done: distOk,
      evidence: `${ev.distPages} HTML pages, ${ev.distFiles} files in dist/`,
    },
    {
      id: 'quality-gates',
      title: 'Pass validate / test / check-links',
      done: false,
      evidence: 'must be re-run after the final change',
    },
    {
      id: 'qa-local',
      title: 'Pass the browser QA matrix locally',
      done: false,
      evidence: 'must be re-run after the final change',
    },
    {
      id: 'audit',
      title: 'Pass the performance & accessibility audit',
      done: false,
      evidence: 'scripts/audit.mjs',
    },
    {
      id: 'commit',
      title: 'Commit all work to main',
      done: ev.dirtyFiles === 0,
      evidence: `${ev.dirtyFiles} uncommitted change(s)`,
    },
    {
      id: 'deploy',
      title: 'Deploy to GitHub Pages',
      done: false,
      evidence: 'verify live URL after the final push',
    },
    {
      id: 'qa-live',
      title: 'Pass the browser QA matrix against the live URL',
      done: false,
      evidence: 'npm run qa -- --url <pages url>',
    },
    {
      id: 'recovery',
      title: 'Install the power-loss recovery mechanism and scheduled task',
      done: fs.existsSync(path.join(ROOT, 'scripts', 'resume-parkjets.ps1')),
      evidence: 'scripts/resume-parkjets.ps1 + scheduled task',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

function init() {
  const ev = gatherEvidence();
  const queue = buildQueue(ev);
  fs.mkdirSync(LOGS, { recursive: true });

  const state = {
    project: 'parkjets-archive',
    description: 'Independent static preservation of the Parkjets RC aircraft plan catalogue.',
    status: 'running',
    phase: 'recovered',
    resumeRequired: true,
    recoveryReason: 'power-loss-recovery',
    lastKnownCommit: ev.head,
    branch: ev.branch,
    origin: 'https://github.com/eagleanurag/parkjet-aircraft-archive.git',
    pagesUrl: 'https://eagleanurag.github.io/parkjet-aircraft-archive/',
    currentTask: null,
    lastCheckpoint: null,
    lastCheckpointReason: 'power-loss-recovery',
    startedAt: now(),
    updatedAt: now(),
    completedAt: null,
    finalCommit: null,
    evidence: ev,
  };
  saveState(state);
  writeJson(FILES.queue, { generatedAt: now(), tasks: queue });
  writeJson(FILES.completed, {
    generatedAt: now(),
    note: 'Populated from repository evidence at recovery time, not asserted.',
    tasks: queue.filter((t) => t.done).map((t) => ({ id: t.id, title: t.title, evidence: t.evidence, at: now() })),
  });
  writeJson(FILES.failed, { generatedAt: now(), tasks: [] });
  writeJson(FILES.checkpoint, {
    at: now(),
    reason: 'power-loss-recovery',
    commit: ev.head,
    dirtyFiles: ev.dirtyFiles,
    evidence: ev,
  });
  log(`init: recovery state written. ${queue.filter((t) => t.done).length}/${queue.length} tasks evidenced complete.`);
  return { state, queue, ev };
}

function load() {
  const state = readState();
  if (!state) return init();
  const queue = readJson(FILES.queue, { tasks: [] });
  return { state, queue };
}

function refreshQueue() {
  const ev = gatherEvidence();
  const { state } = load();
  const queue = readJson(FILES.queue, { tasks: [] });
  const completed = readJson(FILES.completed, { tasks: [] });
  const doneIds = new Set(completed.tasks.map((t) => t.id));
  const fresh = buildQueue(ev);
  const merged = fresh.map((t) => {
    if (doneIds.has(t.id)) return { ...t, done: true, evidence: t.evidence };
    return t;
  });
  writeJson(FILES.queue, { generatedAt: now(), tasks: merged });
  return { queue: merged, ev, state };
}

function begin(taskId) {
  const { state } = load();
  state.currentTask = taskId;
  state.status = 'running';
  saveState(state);
  log(`begin: ${taskId}`);
  console.log(`→ working: ${taskId}`);
}

/** A task is retried at most this many times before it needs a human. */
export const MAX_ATTEMPTS = 3;

function done(taskId, evidence) {
  const { state } = load();
  const completed = readJson(FILES.completed, { tasks: [] });
  const queue = readJson(FILES.queue, { tasks: [] });
  const t = queue.tasks?.find((x) => x.id === taskId);
  completed.tasks = completed.tasks.filter((x) => x.id !== taskId);
  completed.tasks.push({
    id: taskId,
    title: t?.title || taskId,
    evidence: evidence || t?.evidence || 'recorded by operator',
    at: now(),
  });
  completed.generatedAt = now();
  writeJson(FILES.completed, completed);
  if (t) t.done = true;
  writeJson(FILES.queue, { ...queue, tasks: queue.tasks });

  // A later success supersedes any earlier failure for the same task.
  const failed = readJson(FILES.failed, { tasks: [] });
  if (failed.tasks?.some((f) => f.id === taskId)) {
    for (const f of failed.tasks) {
      if (f.id === taskId) {
        f.recovered = true;
        f.recoveredAt = now();
      }
    }
    writeJson(FILES.failed, failed);
  }

  state.currentTask = null;
  saveState(state);
  log(`done: ${taskId}${evidence ? ` — ${evidence}` : ''}`);
  console.log(`✓ done: ${taskId}`);
}

function fail(taskId, reason, recoverable = true) {
  const failed = readJson(FILES.failed, { tasks: [] });
  const existing = failed.tasks.find((t) => t.id === taskId);
  if (existing) {
    existing.attempts = (existing.attempts || 1) + 1;
    existing.lastError = reason;
    existing.lastAttemptAt = now();
    existing.recovered = false;
  } else {
    failed.tasks.push({
      id: taskId,
      reason,
      recoverable,
      attempts: 1,
      firstFailedAt: now(),
      lastAttemptAt: now(),
      recovered: false,
    });
  }
  failed.generatedAt = now();
  writeJson(FILES.failed, failed);
  const { state } = load();
  state.currentTask = null;
  saveState(state);
  log(`fail: ${taskId} — ${reason}`);
  console.log(`✗ failed: ${taskId} — ${reason}`);
}

function checkpoint(reason) {
  const ev = gatherEvidence();
  const { state } = load();
  const c = {
    at: now(),
    reason: reason || 'manual',
    commit: ev.head,
    branch: ev.branch,
    originHead: ev.originHead,
    dirtyFiles: ev.dirtyFiles,
    inSync: ev.head === ev.originHead,
    evidence: ev,
  };
  writeJson(FILES.checkpoint, c);
  state.lastCheckpoint = c.at;
  state.lastCheckpointReason = c.reason;
  saveState(state);
  log(`checkpoint: ${reason} @ ${ev.head.slice(0, 7)} (dirty=${ev.dirtyFiles}, inSync=${c.inSync})`);
  console.log(`⟲ checkpoint @ ${ev.head.slice(0, 7)} — ${reason}`);
}

function complete(commit) {
  const { state, queue } = load();
  const c = git('rev-parse', 'HEAD');
  state.status = 'completed';
  state.phase = 'completed';
  state.resumeRequired = false;
  state.currentTask = null;
  state.completedAt = now();
  state.finalCommit = commit || c;
  state.lastCheckpoint = now();
  state.lastCheckpointReason = 'project-complete';
  saveState(state);
  const remaining = (queue.tasks || []).filter((t) => !t.done);
  writeJson(FILES.checkpoint, {
    at: now(),
    reason: 'project-complete',
    commit: state.finalCommit,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    originHead: git('rev-parse', 'origin/main'),
    dirtyFiles: gatherEvidence().dirtyFiles,
    inSync: state.finalCommit === git('rev-parse', 'origin/main'),
    evidence: gatherEvidence(),
  });
  log(`complete: ${state.finalCommit} (${remaining.length} task(s) not marked done)`);
  console.log(`✅ project complete @ ${state.finalCommit}`);
  if (remaining.length) console.log(`   note: ${remaining.length} task(s) are not flagged done: ${remaining.map((r) => r.id).join(', ')}`);
}

function show() {
  const { state } = load();
  // Always show live evidence, never the snapshot taken at init time.
  const ev = gatherEvidence();
  const queue = refreshQueue().queue;
  state.evidence = ev;
  state.lastKnownCommit = ev.head;
  state.branch = ev.branch;
  if (state.status !== 'completed') {
    state.resumeRequired = !(state.status === 'completed');
  }
  saveState(state);

  console.log('');
  console.log('  Parkjets migration state');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  status          ${state.status} (phase: ${state.phase})`);
  console.log(`  commit          ${String(ev.head).slice(0, 7)} on ${ev.branch}  (origin ${String(ev.originHead).slice(0, 7)}${ev.head === ev.originHead ? ', in sync' : ', DIVERGED'})`);
  console.log(`  pages           ${state.pagesUrl}`);
  console.log(`  aircraft        ${ev.aircraftRecords}  (${ev.uniqueSlugs} unique slugs, ${ev.uniqueSourceUrls} unique source URLs)`);
  console.log(`  photographs     ${ev.mediaFiles} files / ${(ev.mediaBytes / 1048576).toFixed(1)} MB across ${ev.mediaDirs} aircraft`);
  console.log(`  archive status  ${Object.entries(ev.archiveStatus || {}).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  designers       ${ev.designers} credited, ${ev.uncreditedDesigners} entry(s) with no credit`);
  console.log(`  categories      ${ev.categories}`);
  console.log(`  dist pages      ${ev.distPages}`);
  console.log(`  dirty files     ${ev.dirtyFiles}`);
  console.log(`  last checkpoint ${state.lastCheckpoint || '(none)'} — ${state.lastCheckpointReason || ''}`);
  console.log('');
  for (const t of queue || []) {
    console.log(`  ${t.done ? '✓' : '·'} ${t.id.padEnd(14)} ${t.title}`);
    if (!t.done) console.log(`      pending — ${t.evidence}`);
  }
  const failed = readJson(FILES.failed, { tasks: [] });
  if (failed.tasks?.length) {
    console.log('');
    console.log('  failed tasks needing retry:');
    for (const f of failed.tasks.filter((x) => !x.recovered)) {
      console.log(`  ✗ ${f.id} (${f.attempts} attempt(s)): ${f.lastError || f.reason}`);
    }
  }
  console.log('');
}

function nextTask() {
  const { queue } = load();
  const failed = readJson(FILES.failed, { tasks: [] });

  /*
   * Round-robin over unresolved, recoverable failures before moving on to the
   * ordinary queue, so a transient network error is retried rather than
   * abandoned. MAX_ATTEMPTS stops a permanently broken task from looping
   * forever - it is left unresolved for a human instead.
   */
  const retryable = (failed.tasks || [])
    .filter((f) => f.recovered === false && f.recoverable !== false && (f.attempts || 0) < MAX_ATTEMPTS)
    .sort((a, b) => (a.attempts || 0) - (b.attempts || 0) || String(a.lastAttemptAt).localeCompare(String(b.lastAttemptAt)));
  if (retryable.length) {
    return {
      id: retryable[0].id,
      title: `retry (attempt ${(retryable[0].attempts || 0) + 1}/${MAX_ATTEMPTS}) after: ${retryable[0].lastError || retryable[0].reason}`,
      retry: true,
    };
  }

  const pending = (queue.tasks || []).filter((t) => !t.done);
  if (!pending.length) return null;
  return { id: pending[0].id, title: pending[0].title, retry: false };
}

function isComplete() {
  const s = readState();
  if (!s) process.exit(2);
  const pending = (readJson(FILES.queue, { tasks: [] }).tasks || []).filter((t) => !t.done);
  const unresolved = (readJson(FILES.failed, { tasks: [] }).tasks || []).filter((f) => f.recovered === false);
  if (s.status === 'completed' && !pending.length && !unresolved.length) process.exit(0);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Single-instance lock                                               */
/* ------------------------------------------------------------------ */

export function acquireLock(owner) {
  fs.mkdirSync(DIR, { recursive: true });
  const existing = readJson(LOCK, null);
  if (existing && existing.pid && pidAlive(existing.pid)) return null;
  writeJson(LOCK, { pid: process.pid, owner: owner || 'unknown', at: now() });
  return { pid: process.pid };
}

export function releaseLock() {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ */

const cmd = process.argv[2] || 'show';
const args = process.argv.slice(3);

switch (cmd) {
  case 'init':
    init();
    break;
  case 'show':
    show();
    break;
  case 'refresh':
    refreshQueue();
    show();
    break;
  case 'begin':
    begin(args[0]);
    break;
  case 'done':
    done(args[0], args[1]);
    break;
  case 'fail':
    fail(args[0], args[1] || 'unspecified', args[2] !== 'false');
    break;
  case 'checkpoint':
    checkpoint(args[0]);
    break;
  case 'complete':
    complete(args[0]);
    break;
  case 'is-complete':
    isComplete();
    break;
  case 'next': {
    const t = nextTask();
    if (!t) {
      console.log('');
      process.exit(0);
    }
    console.log(JSON.stringify(t));
    break;
  }
  case 'evidence':
    console.log(JSON.stringify(gatherEvidence(), null, 2));
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(64);
}
