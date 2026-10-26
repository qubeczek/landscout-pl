// Backend strony działek: uruchamianie skili Claude Code headless (zadania w tle z monitorowaniem)
// oraz deterministycznych skryptów Pythona (status/notatki). Server-only (Node) — używane przez /api/*.
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import os from 'node:os';

// Katalog projektu (rdzeń: skille w .claude/, skrypty w scripts/, dane w properties/).
// Domyślnie katalog nadrzędny względem site/ (strona uruchamiana z site/); nadpisywalny przez ASSISTANT_DIR.
export const PROJECT_DIR =
  process.env.ASSISTANT_DIR ||
  (basename(process.cwd()) === 'site' ? dirname(process.cwd()) : process.cwd());

// Na Linux/macOS python3, na Windows python (standardowa instalacja z Microsoft Store też ma python3).
const PYTHON = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return 'python3'; } catch {}
  try { execFileSync('python',  ['--version'], { stdio: 'ignore' }); return 'python';  } catch {}
  return 'python3'; // ostateczny fallback — błąd pojawi się przy próbie użycia
})();

export type Job = {
  id: string;
  kind: 'ingest' | 'deepdive' | 'search' | 'reeval';
  status: 'running' | 'done' | 'error';
  label: string;
  output: string;
  result: any | null;
  error: string | null;
  listingId: string | null;
  startedAt: number;
  finishedAt: number | null;
};

// Stan zadań trzymany w pamięci procesu dev-serwera (jeden proces) — wystarcza do pollingu z UI.
const jobs = new Map<string, Job>();
let seq = 0;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

// Lista zadań (najnowsze pierwsze) — do wskaźnika procesów w tle w UI.
export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

// Znajdź trwające zadanie danego rodzaju dla danej oferty — do blokady duplikatów
// (np. wielokrotne kliknięcie „deep-dive"/„Ulubione" nie ma odpalać kolejnych procesów).
export function findRunningJob(kind: Job['kind'], listingId: string): Job | undefined {
  return [...jobs.values()].find((j) => j.status === 'running' && j.kind === kind && j.listingId === listingId);
}

// Ścieżka do Claude Code (NIE Claude Desktop). Jedno źródło prawdy = launcher bin/cdp w repo
// (`cdp --which`); gdy niedostępny, fallback na lokalne rozwiązanie. Sam prompt przekazujemy potem
// binarce bezpośrednio przez argv (bez powłoki) — patrz startClaudeJob.
function resolveViaCdp(): string | null {
  try {
    const isWin = process.platform === 'win32';
    const script = join(PROJECT_DIR, 'bin', isWin ? 'cdp.ps1' : 'cdp');
    if (!existsSync(script)) return null;
    const out = isWin
      ? execFileSync('powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '--which'],
          { encoding: 'utf-8' })
      : execFileSync(script, ['--which'], { encoding: 'utf-8' });
    const p = (out.trim().split(/\r?\n/).pop() || '').trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function resolveClaudeExe(): string {
  // 1. Jawne CLAUDE_EXE z env (site/.env lub powłoki nadrzędnej)
  if (process.env.CLAUDE_EXE && existsSync(process.env.CLAUDE_EXE)) return process.env.CLAUDE_EXE;
  // 2. bin/cdp --which (czyta CLAUDE_EXE lub szuka claude w PATH; działa na obu platformach)
  const viaCdp = resolveViaCdp();
  if (viaCdp) return viaCdp;
  // 3. Fallback: `which claude` — na Linux/macOS bez działającego cdp
  if (process.platform !== 'win32') {
    try {
      const found = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
      if (found && existsSync(found)) return found;
    } catch {}
  }
  // 4. Windows: najnowsza wersja w AppData\Claude\claude-code\<wer>\claude.exe
  const base = join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code');
  if (!existsSync(base)) throw new Error('Nie znaleziono Claude Code. Ustaw CLAUDE_EXE w site/.env lub sprawdź bin/cdp.');
  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  const vers = readdirSync(base)
    .filter((d) => existsSync(join(base, d, 'claude.exe')))
    .sort(cmp);
  if (!vers.length) throw new Error('claude.exe nie znaleziony w ' + base);
  return join(base, vers[0], 'claude.exe');
}

// Uruchom skill Claude Code headless jako zadanie w tle. Prompt instruuje agenta, by wywołał skill
// i na końcu wypisał JSON w ostatniej linii. Zwraca jobId (UI poll-uje /api/job/<id>).
// postRun (opcjonalne) — wywołane synchronicznie po zamknięciu procesu, np. do przeliczenia priorytetu.
export function startClaudeJob(
  kind: Job['kind'], label: string, prompt: string,
  listingId: string | null = null,
  postRun?: (job: Job) => void,
): string {
  const id = `${Date.now()}_${++seq}`;
  const job: Job = {
    id, kind, status: 'running', label, output: '', result: null, error: null,
    listingId, startedAt: Date.now(), finishedAt: null,
  };
  jobs.set(id, job);

  let exe: string;
  try {
    exe = resolveClaudeExe();
  } catch (e: any) {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
    return id;
  }

  const child = spawn(
    exe,
    ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'],
    { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stdout.on('data', (d) => (job.output += d.toString()));
  child.stderr.on('data', (d) => (job.output += d.toString()));
  child.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
  });
  child.on('close', (code) => {
    job.finishedAt = Date.now();
    // ostatni blok {...} w wyjściu = ustrukturyzowany wynik od agenta
    const m = job.output.trim().match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        job.result = JSON.parse(m[0]);
        if (job.result?.id) job.listingId = String(job.result.id);
      } catch {}
    }
    if (code === 0 && job.result?.ok !== false) {
      job.status = 'done';
    } else {
      job.status = 'error';
      job.error = job.result?.error || `Claude Code zakończył się kodem ${code}`;
    }
    if (postRun) { try { postRun(job); } catch {} }
  });
  return id;
}

// Deterministyczne wywołanie manage_listing.py (status/notatki) — synchronicznie, zwraca sparsowany JSON.
export function runManage(args: string[]): any {
  const out = execFileSync(PYTHON, ['scripts/manage_listing.py', ...args], {
    cwd: PROJECT_DIR,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const last = out.trim().split('\n').pop() || '';
  try {
    return JSON.parse(last);
  } catch {
    return { raw: out };
  }
}

// Deterministyczne wywołanie priority_registry.py — synchronicznie, nie rzuca (priority = optional feature).
export function runPriority(args: string[]): any {
  try {
    const out = execFileSync(PYTHON, ['scripts/priority_registry.py', ...args], {
      cwd: PROJECT_DIR,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const last = out.trim().split('\n').pop() || '';
    try { return JSON.parse(last); } catch { return {}; }
  } catch { return {}; }
}
