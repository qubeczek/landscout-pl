import type { APIRoute } from 'astro';
import { startClaudeJob, findRunningJob, runPriority } from '../../server/runner';
import { startDeepDive, notesHaveUnconfirmedParcels } from '../../server/deepdive';

export const prerender = false;

// Ponowna ocena oferty (po każdej zmianie notatki) — przez Claude Code / skill properties-eval:
// najpierw rozpoznanie cech z notatek (media/MPZP/kontakt/rodzaj/nr działki → pola oferty), potem ocena
// z UWZGLĘDNIENIEM notatek. Zapisuje pola + score + sekcję ## Ocena dopasowania.
// Notatka zmieniona w trakcie trwającej re-oceny (która przeczytała notatki wcześniej) → po jej końcu ponów.
const rerunAfter = new Map<string, string | undefined>();

function startReeval(id: string, reason?: string): string {
  const why = reason ? ` (powód: ${reason})` : '';
  const prompt =
    `Ponowna ocena oferty "${id}"${why}. To zadanie ZAPISUJĄCE — wykonaj WSZYSTKIE kroki, nie zatrzymuj ` +
    `się na samej ocenie:\n` +
    `1. Przeczytaj properties/criteria.md (OPIS poszukiwanej działki).\n` +
    `2. \`python scripts/manage_listing.py get --id ${id}\` — weź description, pola ORAZ notes[]. ` +
    `Notatki użytkownika są WIARYGODNIEJSZE niż opis sprzedającego i mają realny wpływ na ocenę.\n` +
    `3. ROZPOZNANIE CECH z notatek — przenieś do pól oferty to, co użytkownik w notatkach STWIERDZIŁ ` +
    `(nowsza notatka wygrywa ze starszą i z opisem sprzedającego; nie zgaduj, nie zeruj pól, których notatki ` +
    `nie dotyczą). Każde pole: \`python scripts/manage_listing.py set --id ${id} --field <pole> --value '<wartość>'\`:\n` +
    `   - media.prad / media.woda / media.kanalizacja / media.gaz — "tak" albo krótki opis (np. "w drodze", "brak", "studnia")\n` +
    `   - mpzp.status (np. "MN", "R", "brak MPZP", "WZ wydane") i mpzp.note (krótko, skąd wiadomo)\n` +
    `   - contact.name / contact.phone / contact.email\n` +
    `   - land_type — rolna | siedliskowa | budowlana\n` +
    `   - parcel.parcel_no_from_note (np. "162/5"; kilka → po przecinku) i parcel.region_from_note (obręb/wieś)\n` +
    `   Jeśli coś zmieniłeś, dopisz do historii: \`manage_listing.py log --id ${id} --text "cechy z notatki: <pola>"\`.\n` +
    `4. Oceń dopasowanie do kryteriów (możesz użyć skilla properties-eval): score 0-100, werdykt ` +
    `(dopasowane|do-weryfikacji|odrzucone), 1 zdanie reason — UWZGLĘDNIJ notatki i rozpoznane cechy.\n` +
    `5. OBOWIĄZKOWO ZAPISZ wynik (bez tego zadanie jest nieukończone):\n` +
    `   - zapamiętaj stary score; \`python scripts/manage_listing.py set --id ${id} --field score --value <nowy_score>\`\n` +
    `   - zapisz plik z treścią "**Ocena: <score>/100 — <werdykt>** (po notatce, <data>)\\n\\n<reason>" i ` +
    `\`python scripts/manage_listing.py set-section --id ${id} --header "Ocena dopasowania" --text-file <plik>\`\n` +
    `   - dopisz do historii: \`python scripts/manage_listing.py log --id ${id} --text "ponowna ocena (notatka): score <nowy> (było <stary>)"\`\n` +
    `6. **STATUSU NIE ZMIENIAJ** — to istniejąca oferta, re-ocena rusza tylko score/ocenę/datę, nie status.\n` +
    `7. Na samym końcu wypisz w OSTATNIEJ linii TYLKO czysty JSON: {"ok":true,"id":"${id}","score":<liczba>} ` +
    `(albo {"ok":false,"error":"..."}). NIE kończ na tablicy z oceny — wynik MUSI być zapisany w kroku 5.`;
  return startClaudeJob('reeval', `ponowna ocena: ${id}`, prompt, id,
    (job) => {
      if (rerunAfter.has(id)) {
        const r = rerunAfter.get(id);
        rerunAfter.delete(id);
        startReeval(id, r);  // deep-dive (jeśli potrzebny) odpali się po tej ponownej rundzie
        return;
      }
      if (job.status !== 'done') return;
      runPriority(['recompute', '--id', id]);
      // notatka podała numery działek, a karta ich nie potwierdza → deep-dive rozwiąże je w ULDK
      if (notesHaveUnconfirmedParcels(id)) {
        startDeepDive(id, `Użytkownik podał w notatce numery działek — rozwiąż je i zaktualizuj blok parcel. `);
      }
    },
  );
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { id, reason } = await request.json();
    if (!id) return new Response(JSON.stringify({ ok: false, error: 'Brak id' }), { status: 400 });
    const existing = findRunningJob('reeval', id);
    if (existing) {
      rerunAfter.set(id, reason);
      return new Response(JSON.stringify({ ok: true, jobId: existing.id, alreadyRunning: true, queued: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const jobId = startReeval(id, reason);
    return new Response(JSON.stringify({ ok: true, jobId }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
};
