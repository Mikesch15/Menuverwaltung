// Liest ein Rezept von einer Webseite (schema.org/Recipe in JSON-LD, wie es die meisten
// Rezeptseiten wie Betty Bossi, Fooby, Swissmilk oder Chefkoch einbetten).
// Aufruf nur für angemeldete Nutzer (verify_jwt).

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', frac12: '½', frac14: '¼', frac34: '¾' };
function text(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, n) => ENTITIES[n] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

type Obj = Record<string, unknown>;
function findeRezept(node: unknown): Obj | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findeRezept(n); if (r) return r; }
    return null;
  }
  const o = node as Obj;
  const typ = o['@type'];
  if (typ === 'Recipe' || (Array.isArray(typ) && typ.includes('Recipe'))) return o;
  return findeRezept(o['@graph']) || findeRezept(o['mainEntity']);
}

function anleitung(x: unknown): string[] {
  if (!x) return [];
  if (typeof x === 'string') return [text(x)];
  if (Array.isArray(x)) return x.flatMap(anleitung);
  const o = x as Obj;
  if (o['@type'] === 'HowToSection') return [`${text(o.name)}:`, ...anleitung(o.itemListElement)];
  return [text(o.text ?? o.name)];
}

function minuten(iso: unknown): number | null {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(iso ?? ''));
  if (!m) return null;
  const min = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return min > 0 ? min : null;
}

function bild(x: unknown): string | null {
  if (!x) return null;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return bild(x[0]);
  return bild((x as Obj).url);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { url } = await req.json();
    let ziel: URL;
    try { ziel = new URL(url); } catch { return json({ error: 'Ungültiger Link' }, 400); }
    if (!['http:', 'https:'].includes(ziel.protocol)) return json({ error: 'Ungültiger Link' }, 400);

    const res = await fetch(ziel, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Menuplan-Rezeptimport/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-CH,de;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return json({ error: `Seite nicht erreichbar (${res.status})` }, 502);
    const html = (await res.text()).slice(0, 4_000_000);

    let rezept: Obj | null = null;
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { rezept = findeRezept(JSON.parse(m[1].trim())); } catch { /* ungültiges JSON überspringen */ }
      if (rezept) break;
    }
    const ogTitel = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1];
    if (!rezept) {
      return json({ gefunden: false, name: text(ogTitel || /<title>([^<]*)/i.exec(html)?.[1] || ''), quelle_url: ziel.href });
    }
    const ertrag = Array.isArray(rezept.recipeYield) ? rezept.recipeYield.join(' ') : String(rezept.recipeYield ?? '');
    const portionen = Number(/\d+/.exec(ertrag)?.[0]) || null;
    return json({
      gefunden: true,
      name: text(rezept.name || ogTitel),
      zutaten: (Array.isArray(rezept.recipeIngredient) ? rezept.recipeIngredient : []).map(text).filter(Boolean),
      anleitung: anleitung(rezept.recipeInstructions).filter(Boolean).join('\n'),
      kochzeit: minuten(rezept.totalTime) || ((minuten(rezept.prepTime) || 0) + (minuten(rezept.cookTime) || 0)) || null,
      portionen: portionen && portionen <= 50 ? portionen : null,
      bild: bild(rezept.image),
      quelle_url: ziel.href,
    });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
