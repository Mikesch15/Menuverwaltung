// Reine Hilfslogik ohne DOM/Datenbank: Abteilungen raten, Zutaten zerlegen, Mengen rechnen.

export const ABTEILUNGEN = [
  { id: 'gemuese', name: 'Gemüse & Früchte', icon: '🥕' },
  { id: 'brot', name: 'Brot & Backwaren', icon: '🥖' },
  { id: 'milch', name: 'Milchprodukte & Eier', icon: '🧀' },
  { id: 'fleisch', name: 'Fleisch & Fisch', icon: '🥩' },
  { id: 'kuehl', name: 'Kühlregal', icon: '🧊' },
  { id: 'tk', name: 'Tiefkühl', icon: '❄️' },
  { id: 'vorrat', name: 'Vorrat & Konserven', icon: '🥫' },
  { id: 'gewuerz', name: 'Gewürze, Öl & Saucen', icon: '🧂' },
  { id: 'getraenke', name: 'Getränke', icon: '🥤' },
  { id: 'haushalt', name: 'Haushalt', icon: '🧻' },
  { id: 'sonstiges', name: 'Sonstiges', icon: '🛒' },
];

export const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Reihenfolge ist wichtig: spezifische Begriffe zuerst (z.B. «Tomaten passiert» → Vorrat, nicht Gemüse).
const REGELN = [
  ['milch', ['saucenrahm', 'halbrahm', 'vollrahm', 'kaffeerahm', 'sauerrahm']],
  ['vorrat', ['teigwaren', 'passiert', 'pelati', 'dose', 'konserve', 'kokosmilch', 'bouillon', 'bruhe', 'tomatenmark', 'thon', 'thunfisch']],
  ['gewuerz', ['salz', 'pfeffer', 'pulver', 'curry', 'gewurz', 'ol', 'olivenol', 'essig', 'senf', 'ketchup', 'mayo', 'sojasauce', 'pesto', 'honig', 'zimt', 'muskat', 'oregano', 'paprikapulver', 'chili', 'sauce', 'aceto', 'balsamico', 'currypaste', 'aromat', 'streuwurze', 'vanille']],
  ['tk', ['tiefkuhl', 'tk', 'erbsli', 'erbsen', 'glace', 'rahmspinat', 'pommes']],
  ['kuehl', ['teig', 'gnocchi', 'gnoggi', 'spatzli', 'tofu', 'frischteigwaren', 'ravioli', 'tortellini']],
  ['milch', ['milch', 'rahm', 'sahne', 'butter', 'kase', 'mozzarella', 'feta', 'parmesan', 'sbrinz', 'gruyere', 'raclette', 'huttenkase', 'quark', 'joghurt', 'jogurt', 'mascarpone', 'creme fraiche', 'ei', 'eier', 'ricotta', 'frischkase', 'emmentaler', 'cottage']],
  ['fleisch', ['fleisch', 'hack', 'gehackt', 'poulet', 'huhn', 'hahnchen', 'hunchen', 'rind', 'schwein', 'kalb', 'speck', 'schinken', 'wurst', 'wurstli', 'cervelat', 'wienerli', 'salami', 'filet', 'geschnetzelt', 'crevetten', 'lachs', 'fisch', 'lamm', 'cordon', 'chorizo', 'entrecote', 'plätzli', 'platzli']],
  ['brot', ['brot', 'zopf', 'gipfeli', 'toast', 'brotchen', 'weggli', 'tortilla', 'wrap', 'fladenbrot', 'bun', 'baguette', 'semmel']],
  ['gemuese', ['tomate', 'gurke', 'ruebli', 'rüebli', 'karotte', 'zwiebel', 'knoblauch', 'lauch', 'kartoffel', 'salat', 'zucchetti', 'zucchini', 'peperoni', 'paprika', 'brokkoli', 'broccoli', 'blumenkohl', 'kohl', 'spinat', 'champignon', 'pilz', 'apfel', 'banane', 'zitrone', 'limette', 'beere', 'avocado', 'ingwer', 'petersilie', 'basilikum', 'schnittlauch', 'krauter', 'koriander', 'sellerie', 'fenchel', 'kurbis', 'aubergine', 'kohlrabi', 'rucola', 'randen', 'birne', 'orange', 'trauben', 'bohnen', 'spargel', 'mais', 'lauch', 'rosmarin', 'thymian', 'minze', 'frucht', 'obst']],
  ['vorrat', ['reis', 'risotto', 'teigwaren', 'spaghetti', 'hornli', 'nudeln', 'penne', 'fusilli', 'lasagne', 'couscous', 'bulgur', 'mehl', 'zucker', 'linsen', 'haferflocken', 'oliven', 'nusse', 'mandeln', 'schokolade', 'kakao', 'backpulver', 'hefe', 'paniermehl', 'polenta', 'quinoa', 'kichererbsen', 'gries', 'griess', 'konfiture', 'confiture']],
  ['getraenke', ['wasser', 'saft', 'bier', 'wein', 'cola', 'sirup', 'kaffee', 'tee', 'mineral']],
  ['haushalt', ['papier', 'spulmittel', 'waschmittel', 'folie', 'beutel', 'servietten', 'schwamm', 'abfallsack', 'kuchenrolle', 'zahnpasta', 'shampoo']],
];

/** Abteilung anhand des Artikelnamens raten. */
export function abteilungRaten(name) {
  const tokens = norm(name).split(/[^a-z]+/).filter(Boolean);
  const ganz = norm(name);
  for (const [abt, woerter] of REGELN) {
    for (const w of woerter) {
      const wn = norm(w);
      if (wn.includes(' ') ? ganz.includes(wn) : tokens.some((t) => (wn.length <= 3 ? t === wn : t.includes(wn)))) return abt;
    }
  }
  return 'sonstiges';
}

const BRUECHE = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
const EINHEITEN = 'g|gr|kg|mg|ml|cl|dl|l|el|tl|msp|prisen?|stk|stück|bund|dosen?|becher|pck|päckchen|packung(?:en)?|zehen?|scheiben?|tassen?|gläser|glas|zweige?|handvoll|blätter|blatt|beutel|würfel|köpfe|kopf|knollen?|stangen?|liter|gramm|esslöffel|teelöffel|kilo';
const ZAHL = '(?:ca\\.?\\s*)?(?:\\d+\\s+\\d+/\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[-–/]\\s*\\d+(?:[.,]\\d+)?)?\\s*[½¼¾⅓⅔]?|[½¼¾⅓⅔⅛])';
const ZEILE = new RegExp(`^\\s*(${ZAHL}(?:\\s*(?:${EINHEITEN})\\.?(?=[\\s,]|$))?)\\s+(.+)$`, 'i');

/** «200 g Mehl, gesiebt» → { menge: '200 g', name: 'Mehl' } */
export function zutatParsen(zeile) {
  const z = String(zeile).replace(/\s+/g, ' ').trim();
  const m = ZEILE.exec(z);
  let menge = '', name = z;
  if (m) { menge = m[1].trim(); name = m[2].trim(); }
  name = name.replace(/^(?:von|vom)\s+/i, '').split(/,(?![^(]*\))/)[0].trim();
  return { name: name.charAt(0).toUpperCase() + name.slice(1), menge };
}

const zahlLesen = (roh) => {
  const gemischt = /^(\d+)\s+(\d+)\/(\d+)$/.exec(roh.trim());
  if (gemischt) return Number(gemischt[1]) + Number(gemischt[2]) / Number(gemischt[3]);
  const s = roh.replace(/\s+/g, '');
  if (BRUECHE[s] !== undefined) return BRUECHE[s];
  const mitBruch = /^(\d+)\s*([½¼¾⅓⅔])$/.exec(s);
  if (mitBruch) return Number(mitBruch[1]) + BRUECHE[mitBruch[2]];
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : a; }
  return Number(s.replace(',', '.'));
};
const zahlSchreiben = (n) => {
  const r = n >= 20 ? Math.round(n) : n >= 3 ? Math.round(n * 2) / 2 : Math.round(n * 100) / 100;
  return String(r).replace('.', ',');
};

/** Alle Zahlen in einer Mengenangabe mit dem Faktor multiplizieren. */
export function mengeSkalieren(menge, faktor) {
  if (!menge || !faktor || Math.abs(faktor - 1) < 0.001) return menge || '';
  return menge.replace(/\d+\s+\d+\/\d+|\d+\s*[½¼¾⅓⅔]|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛]/g, (m) => zahlSchreiben(zahlLesen(m) * faktor));
}

const EINHEIT_NORM = { gr: 'g', gramm: 'g', liter: 'l', stück: 'stk', kilo: 'kg' };
// Gewichte und Volumen in eine Basiseinheit umrechnen, damit «1 kg» + «500 g» zusammenpassen
const BASIS = { g: ['g', 1], kg: ['g', 1000], mg: ['g', 0.001], ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100], l: ['ml', 1000] };
function mengeZerlegen(menge) {
  const m = /^\s*(\d+\s+\d+\/\d+|\d+\s*[½¼¾⅓⅔]|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛])\s*([a-zäöü.]*)\s*$/i.exec(menge || '');
  if (!m) return null;
  let e = m[2].toLowerCase().replace(/\.$/, '');
  e = EINHEIT_NORM[e] || e;
  let zahl = zahlLesen(m[1]);
  if (BASIS[e]) { zahl *= BASIS[e][1]; e = BASIS[e][0]; }
  return { zahl, einheit: e, roh: m[2] };
}
function basisSchreiben(zahl, einheit, roh) {
  if (einheit === 'g') return zahl >= 1000 ? `${zahlSchreiben(zahl / 1000)} kg` : `${zahlSchreiben(zahl)} g`;
  if (einheit === 'ml') return zahl >= 1000 ? `${zahlSchreiben(zahl / 1000)} l` : zahl >= 100 ? `${zahlSchreiben(zahl / 100)} dl` : `${zahlSchreiben(zahl)} ml`;
  return `${zahlSchreiben(zahl)}${roh ? ' ' + roh : ''}`;
}

/** Mehrere Mengen desselben Artikels zusammenfassen: «200 g» + «300 g» → «500 g». */
export function mengenZusammen(mengen) {
  const liste = mengen.map((m) => (m || '').trim()).filter(Boolean);
  if (liste.length <= 1) return liste[0] || '';
  const teile = liste.map(mengeZerlegen);
  if (teile.every(Boolean) && teile.every((t) => t.einheit === teile[0].einheit)) {
    return basisSchreiben(teile.reduce((a, t) => a + t.zahl, 0), teile[0].einheit, teile[0].roh);
  }
  return liste.join(' + ');
}
