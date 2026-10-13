import type { APIRoute } from 'astro';
import { startDeepDive } from '../../server/deepdive';

export const prerender = false;

// Wyzwolenie pogłębionej analizy (properties-deep-dive) przez Claude Code headless.
// Można uruchomić ponownie (skill/dane mogły się zmienić), ale NIE równolegle dla tej samej oferty —
// wielokrotne kliknięcie „deep-dive"/„Ulubione" podpina się pod trwające zadanie zamiast mnożyć procesy.
export const POST: APIRoute = async ({ request }) => {
  try {
    const { id, favorite } = await request.json();
    if (!id) return new Response(JSON.stringify({ ok: false, error: 'Brak id' }), { status: 400 });
    const favNote = favorite
      ? `Oferta została właśnie oznaczona jako Ulubiona — to wyzwolenie deep-dive. `
      : '';
    const { jobId, alreadyRunning } = startDeepDive(id, favNote);
    return new Response(JSON.stringify({ ok: true, jobId, alreadyRunning }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
};
