// Push-Erinnerungen für den Menüplan.
//
// Aufrufe:
//  - {modus: "cron"}       stündlich per pg_cron, geschützt mit dem Header x-cron-secret
//  - {modus: "schluessel"} angemeldete Nutzer holen den öffentlichen VAPID-Schlüssel
//  - {modus: "test"}       angemeldete Nutzer schicken sich selbst eine Test-Mitteilung
//
// Die VAPID-Schlüssel werden beim ersten Aufruf erzeugt und in menu_push_config gespeichert
// (Tabelle ohne Policies, nur mit dem Service-Role-Schlüssel lesbar).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const APP_URL = 'https://mikesch15.github.io/Menuverwaltung/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

type Config = { vapid_public: string; vapid_private: string; vapid_subject: string; cron_secret: string };

async function config(): Promise<Config> {
  const { data } = await admin.from('menu_push_config').select('*').eq('id', 1).maybeSingle();
  if (data) return data as Config;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const pub = new Uint8Array([4, ...unb64url(jwk.x!), ...unb64url(jwk.y!)]);
  await admin.from('menu_push_config').upsert(
    { id: 1, vapid_public: b64url(pub), vapid_private: jwk.d!, vapid_subject: APP_URL },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  const { data: neu, error } = await admin.from('menu_push_config').select('*').eq('id', 1).single();
  if (error) throw error;
  return neu as Config;
}

async function nutzer(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user ?? null;
}

type Abo = { id: string; haushalt_id: string; user_id: string; endpoint: string; p256dh: string; auth: string; taeglich: boolean; wochenplan: boolean };

async function senden(cfg: Config, abo: Abo, payload: Record<string, unknown>) {
  try {
    await webpush.sendNotification(
      { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: cfg.vapid_subject, publicKey: cfg.vapid_public, privateKey: cfg.vapid_private }, TTL: 3 * 3600 },
    );
    return true;
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) await admin.from('menu_push_abos').delete().eq('id', abo.id);
    console.error('Push fehlgeschlagen', status, (e as Error).message);
    return false;
  }
}

/** Datum/Stunde/Wochentag in Zürcher Zeit. */
function zuerich(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { datum: `${p.year}-${p.month}-${p.day}`, stunde: Number(p.hour), wochentag: p.weekday as string };
}
const plusTage = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function erinnerungen(cfg: Config) {
  const jetzt = zuerich();
  const { data: abos } = await admin.from('menu_push_abos').select('*').eq('stunde', jetzt.stunde);
  if (!abos?.length) return { gesendet: 0 };
  let gesendet = 0;
  const haushalte = [...new Set(abos.map((a: Abo) => a.haushalt_id))];
  for (const hid of haushalte) {
    const [{ data: heute }, { data: woche }, { count: offen }, { data: mitglieder }] = await Promise.all([
      admin.from('menu_plan').select('titel, koch_user').eq('haushalt_id', hid).eq('datum', jetzt.datum),
      admin.from('menu_plan').select('datum').eq('haushalt_id', hid).gte('datum', plusTage(jetzt.datum, 1)).lte('datum', plusTage(jetzt.datum, 7)),
      admin.from('menu_einkauf').select('id', { count: 'exact', head: true }).eq('haushalt_id', hid).eq('erledigt', false),
      admin.from('menu_mitglieder').select('user_id, anzeigename').eq('haushalt_id', hid),
    ]);
    const namen = new Map((mitglieder || []).map((m) => [m.user_id, m.anzeigename]));
    const geplanteTage = new Set((woche || []).map((w) => w.datum)).size;

    for (const abo of abos.filter((a: Abo) => a.haushalt_id === hid) as Abo[]) {
      if (abo.taeglich && heute?.length) {
        const koch = heute.map((h) => h.koch_user).find(Boolean);
        const teile = [];
        if (koch) teile.push(koch === abo.user_id ? 'Du kochst heute.' : `${namen.get(koch) || 'Dein Schatz'} kocht heute.`);
        if (offen) teile.push(`${offen} Artikel auf der Einkaufsliste – schon alles eingekauft?`);
        if (await senden(cfg, abo, {
          title: `Heute: ${heute.map((h) => h.titel).join(' & ')}`,
          body: teile.join(' ') || 'En Guete! 🍽️',
          url: APP_URL, tag: 'heute',
        })) gesendet++;
      }
      if (abo.wochenplan && jetzt.wochentag === 'Sun' && geplanteTage < 7) {
        if (await senden(cfg, abo, {
          title: 'Menüplan für nächste Woche',
          body: geplanteTage ? `Erst ${geplanteTage} von 7 Tagen geplant. Jetzt ergänzen?` : 'Die nächste Woche ist noch leer. Jetzt planen? 🎲',
          url: APP_URL, tag: 'woche',
        })) gesendet++;
      }
    }
  }
  return { gesendet };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const cfg = await config();

    if (body.modus === 'cron') {
      if (req.headers.get('x-cron-secret') !== cfg.cron_secret) return json({ error: 'Nicht erlaubt' }, 401);
      return json(await erinnerungen(cfg));
    }

    const user = await nutzer(req);
    if (!user) return json({ error: 'Nicht angemeldet' }, 401);

    if (body.modus === 'schluessel') return json({ publicKey: cfg.vapid_public });

    if (body.modus === 'test') {
      const { data: abos } = await admin.from('menu_push_abos').select('*').eq('user_id', user.id);
      let ok = 0;
      for (const abo of (abos || []) as Abo[]) {
        if (await senden(cfg, abo, { title: 'Menüplan', body: 'Mitteilungen funktionieren 🎉', url: APP_URL, tag: 'test' })) ok++;
      }
      return json({ gesendet: ok, abos: abos?.length || 0 });
    }

    return json({ error: 'Unbekannter Modus' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
