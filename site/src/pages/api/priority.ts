import type { APIRoute } from 'astro';
import { runPriority } from '../../server/runner';

export const prerender = false;

// Ręczne ustawienie priorytetu (drag & drop) — deterministyczne, synchroniczne.
// Body: { id: string, priority: number }
// Priorytet = liczba rzeczywista; wyższy = wyżej na liście.
// Zawsze oznacza jako manual=true (użytkownik świadomie ustawił kolejność).
export const POST: APIRoute = async ({ request }) => {
  try {
    const { id, priority } = await request.json();
    if (!id || typeof priority !== 'number' || !isFinite(priority)) {
      return new Response(JSON.stringify({ ok: false, error: 'Brak id lub niepoprawna wartość priority' }), { status: 400 });
    }
    const res = runPriority(['set', '--id', id, '--priority', String(priority), '--manual']);
    return new Response(JSON.stringify({ ok: true, ...res }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
};
