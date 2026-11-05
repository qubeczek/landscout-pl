// Wspólne wyzwalanie deep-dive (properties-deep-dive) — z endpointu /api/deepdive oraz automatycznie
// po ponownej ocenie, gdy notatka użytkownika podaje numery działek, a blok `parcel` jest niepotwierdzony.
import { startClaudeJob, findRunningJob } from './runner';
import { readListing } from './listings';

// Numer ewidencyjny działki: „79/1", „123/45", „dz. 18" — wymagamy formy z ukośnikiem albo słowa-klucza.
const PARCEL_NO_RE = /\b\d{1,5}\/\d{1,4}\b|\b(?:dz(?:iałk[aiy])?\.?|nr|numer(?:y)?)\s*(?:ewid\.?\s*)?\d{1,5}\b/i;

export function startDeepDive(id: string, reason = ''): { jobId: string; alreadyRunning: boolean } {
  const existing = findRunningJob('deepdive', id);
  if (existing) return { jobId: existing.id, alreadyRunning: true };
  const prompt =
    `${reason}Użyj skilla properties-deep-dive dla oferty o id "${id}". ` +
    `Wykonaj pełną pogłębioną analizę (geoportal/ULDK, NMT, odległości, oględziny zdjęć) i zapisz wynik ` +
    `do sekcji "## Analiza pogłębiona" oraz pola deep_dive (data/historia) przez manage_listing.py. ` +
    `Numery działek i obręb szukaj także w notatkach użytkownika (notes[]) — mają pierwszeństwo nad opisem. ` +
    `Jeśli numeru z notatki nie ma w ULDK (częsta pomyłka przy dyktowaniu przez telefon), sprawdź w tym obrębie ` +
    `warianty różniące się jedną cyfrą (np. 162/5 → 152/5, 162/3, 16/5) i wskaż w analizie kandydata, którego ` +
    `powierzchnia zgadza się z ofertą (±10%) — jako SUGESTIĘ do potwierdzenia, nie ustawiaj confirmed=true. ` +
    `Uruchom analizę nawet jeśli była już wcześniej (odśwież ją). ` +
    `Na końcu wypisz w OSTATNIEJ linii wyłącznie czysty JSON: ` +
    `{"ok":true,"id":"${id}"} albo {"ok":false,"error":"<powód>"}.`;
  return { jobId: startClaudeJob('deepdive', `deep-dive: ${id}`, prompt, id), alreadyRunning: false };
}

// Czy notatki wskazują numery działek, których blok `parcel` jeszcze nie potwierdza?
export function notesHaveUnconfirmedParcels(id: string): boolean {
  const l = readListing(id);
  if (!l || l.parcel?.confirmed === true) return false;
  const notes: any[] = Array.isArray(l.notes) ? l.notes : [];
  return notes.some((n) => PARCEL_NO_RE.test(String(n?.text ?? '')));
}
