// Odczyt ofert WPROST z dysku (properties/listings/*.md) na każde żądanie — bez content-layer cache,
// więc strona zawsze pokazuje aktualny stan zaraz po mutacji (status/notatki/deep-dive). Server-only.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { PROJECT_DIR } from './runner';

const DIR = join(PROJECT_DIR, 'properties', 'listings');
const ID_RE = /^\d{8}_\d{3,}$/;

export type Listing = Record<string, any> & { id: string; _body: string };

export function readListing(id: string): Listing | null {
  if (!ID_RE.test(id)) return null;
  const p = join(DIR, id + '.md');
  if (!existsSync(p)) return null;
  const { data, content } = matter(readFileSync(p, 'utf-8'));
  return { ...data, id: data.id || id, _body: content };
}

export function readAllListings(): Listing[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.md') && ID_RE.test(f.slice(0, -3)))
    .map((f) => readListing(f.slice(0, -3)))
    .filter((x): x is Listing => x !== null);
}

// Link do ogłoszenia do wyświetlenia. OLX: format `/d/oferta/…` (desktop) otwiera aplikację mobilną,
// ale ta nie pokazuje ogłoszenia — rozpoznaje tylko `/oferta/…` (OLX i tak przekierowuje go
// na `/d/oferta/` w przeglądarce desktopowej i na `m.olx.pl/oferta/` na telefonie).
export function offerHref(url: string): string {
  return url.replace(/^(https?:\/\/(?:www\.|m\.)?olx\.pl)\/d\/oferta\//, '$1/oferta/');
}

export function renderMarkdown(md: string): string {
  return marked.parse(md || '', { async: false }) as string;
}

const PRIORITY_PATH = join(PROJECT_DIR, 'properties', 'priority_registry.json');

export type PriorityEntry = { priority: number; manual: boolean; updated_at?: string };
export type PriorityRegistry = Record<string, PriorityEntry>;

export function readPriorityRegistry(): PriorityRegistry {
  try {
    if (!existsSync(PRIORITY_PATH)) return {};
    return JSON.parse(readFileSync(PRIORITY_PATH, 'utf-8')) as PriorityRegistry;
  } catch { return {}; }
}

const STATUS_PRIORITY_BASE: Record<string, number> = {
  favorite: 400_000, watch: 300_000, active: 200_000, inactive: 100_000,
};

export function autoPriority(status: string, score: number | null | undefined): number {
  return (STATUS_PRIORITY_BASE[status] ?? 100_000) + (score ?? 0) * 100;
}
