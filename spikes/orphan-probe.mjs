import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const own = resolve(process.argv[1]);
const mode = process.argv[2];

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stop(pid) {
  if (!alive(pid)) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

function stopOnly(pid) {
  if (!alive(pid)) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch {}
}

async function waitFile(path, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() <= end) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch {}
    }
    if (Date.now() > end) throw new Error(`timed out: ${path}`);
    await delay(25);
  }
  throw new Error(`timed out: ${path}`);
}

if (mode === 'leaf-ignore') {
  setInterval(() => {}, 1000);
} else if (mode === 'leaf-eof') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === 'grandchild') {
  writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1000);
} else if (mode === 'hub') {
  const [kind, file, grandFile, gate, grandGate] = process.argv.slice(3);
  if (gate) while (!existsSync(gate)) await delay(25);
  let child;
  if (kind === 'ignore' || kind === 'eof') {
    child = spawn(process.execPath, [own, `leaf-${kind}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } else if (kind === 'shell') {
    const waitGrand = grandGate ? `while (!(Test-Path -LiteralPath '${grandGate.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 25 }; ` : '';
    child = spawn('powershell.exe', ['-NoProfile', '-Command', `${waitGrand}& '${process.execPath.replaceAll("'", "''")}' '${own.replaceAll("'", "''")}' grandchild '${grandFile.replaceAll("'", "''")}'`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } else if (kind === 'claude') {
    child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } else if (kind === 'codex') {
    child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } else throw new Error(kind);
  child.stdout.resume(); child.stderr.resume();
  child.once('error', (error) => writeFileSync(file, JSON.stringify({ hub: process.pid, error: error.message })));
  child.once('spawn', () => writeFileSync(file, JSON.stringify({ hub: process.pid, child: child.pid, kind })));
  setInterval(() => {}, 1000);
} else if (mode === 'watch') {
  const [hubText, file, result] = process.argv.slice(3);
  const hub = Number(hubText);
  while (alive(hub)) await delay(100);
  const detected = Date.now();
  const { child } = await waitFile(file);
  stop(child);
  writeFileSync(result, JSON.stringify({ detected, stopped: Date.now(), child }));
} else if (mode === 'run-job') {
  const temp = mkdtempSync(join(tmpdir(), 'clodex-orphan-job-'));
  const helper = resolve('spikes/orphan-job.ps1');
  for (const kind of ['ignore', 'shell', 'preassign', 'nested']) {
    const file = join(temp, `${kind}.json`);
    const grandFile = join(temp, `${kind}-grand.json`);
    const gate = kind === 'nested' ? join(temp, `${kind}-gate`) : '';
    const grandGate = kind === 'ignore' || kind === 'preassign' ? '' : join(temp, `${kind}-grand-gate`);
    const hub = spawn(process.execPath, [own, 'hub', kind === 'nested' || kind === 'preassign' ? 'shell' : kind, file, grandFile, gate, grandGate], { stdio: 'ignore', windowsHide: true });
    let child; let grandchild; let inner; let outer;
    const result = join(temp, `${kind}-job.json`);
    try {
      if (gate) {
        const outerResult = join(temp, `${kind}-outer.json`);
        outer = spawn('powershell.exe', ['-NoProfile', '-File', helper, '-HubPid', String(hub.pid), '-TargetPid', String(hub.pid), '-ResultFile', outerResult], { stdio: 'ignore', windowsHide: true });
        const assigned = await waitFile(outerResult, 30000);
        if (assigned.status === 'error') throw new Error(`outer: ${assigned.message}`);
        writeFileSync(gate, 'go');
      }
      child = (await waitFile(file, 30000)).child;
      if (kind === 'preassign') grandchild = (await waitFile(grandFile)).pid;
      inner = spawn('powershell.exe', ['-NoProfile', '-File', helper, '-HubPid', String(hub.pid), '-TargetPid', String(child), '-ResultFile', result], { stdio: 'ignore', windowsHide: true });
      const assigned = await waitFile(result, 30000);
      if (assigned.status === 'error') throw new Error(assigned.message);
      if (grandGate) {
        writeFileSync(grandGate, 'go');
        grandchild = (await waitFile(grandFile)).pid;
      }
      const before = { child: alive(child), grandchild: alive(grandchild) };
      const killedAt = Date.now();
      stopOnly(hub.pid);
      const end = Date.now() + 5000;
      let closed;
      while (Date.now() < end) {
        try { closed = JSON.parse(readFileSync(result, 'utf8')); } catch { await delay(25); continue; }
        if (closed.status === 'closed') break;
        await delay(25);
      }
      await delay(150);
      console.log(JSON.stringify({ kind: `job-${kind}`, hub: hub.pid, child, grandchild, before, after: { child: alive(child), grandchild: alive(grandchild) }, compileMs: assigned.compiled - assigned.started, assignMs: assigned.assigned - assigned.started, closeMs: closed?.closed - killedAt, status: closed?.status }));
    } catch (error) { console.error(`job-${kind}`, error); }
    finally { stop(hub.pid); stop(child); stop(grandchild); stop(inner?.pid); stop(outer?.pid); }
  }
  console.log(`temp=${temp}`);
} else if (mode === 'run') {
  const temp = mkdtempSync(join(tmpdir(), 'clodex-orphan-'));
  const cases = ['ignore', 'eof', 'shell', 'claude', 'codex'];
  for (const kind of cases) {
    const file = join(temp, `${kind}.json`);
    const grandFile = join(temp, `${kind}-grand.json`);
    const hub = spawn(process.execPath, [own, 'hub', kind, file, grandFile], { stdio: 'ignore', windowsHide: true });
    let child; let grandchild;
    try {
      const info = await waitFile(file);
      if (info.error) throw new Error(info.error);
      child = info.child;
      if (kind === 'shell') grandchild = (await waitFile(grandFile)).pid;
      await delay(kind === 'claude' || kind === 'codex' ? 1800 : 350);
      const before = { child: alive(child), grandchild: alive(grandchild) };
      const killedAt = Date.now();
      stopOnly(hub.pid);
      await delay(1500);
      console.log(JSON.stringify({ kind, hub: hub.pid, child, grandchild, before, after: { child: alive(child), grandchild: alive(grandchild) }, waitedMs: Date.now() - killedAt }));
    } catch (error) { console.error(kind, error); }
    finally { stop(hub.pid); stop(child); stop(grandchild); }
  }
  for (const kind of ['ignore', 'shell']) {
    const file = join(temp, `watch-${kind}.json`);
    const grandFile = join(temp, `watch-${kind}-grand.json`);
    const result = join(temp, `watch-${kind}-result.json`);
    const hub = spawn(process.execPath, [own, 'hub', kind, file, grandFile], { stdio: 'ignore', windowsHide: true });
    let child; let grandchild; let watch;
    try {
      child = (await waitFile(file)).child;
      if (kind === 'shell') grandchild = (await waitFile(grandFile)).pid;
      watch = spawn(process.execPath, [own, 'watch', String(hub.pid), file, result], { detached: true, stdio: 'ignore', windowsHide: true });
      watch.unref();
      await delay(300);
      const killedAt = Date.now();
      stopOnly(hub.pid);
      const outcome = await waitFile(result);
      await delay(100);
      console.log(JSON.stringify({ kind: `watch-${kind}`, hub: hub.pid, child, grandchild, detectionMs: outcome.detected - killedAt, stopMs: outcome.stopped - killedAt, after: { child: alive(child), grandchild: alive(grandchild) } }));
    } catch (error) { console.error(`watch-${kind}`, error); }
    finally { stop(hub.pid); stop(child); stop(grandchild); stop(watch?.pid); }
  }
  console.log(`temp=${temp}`);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
