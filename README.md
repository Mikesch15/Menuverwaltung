# Menüplan

Gemeinsamer Menüplan und Gerichte-Sammlung für zwei (oder mehr) Personen –
als Web-App, die sich auf dem Handy wie eine App auf den Startbildschirm legen lässt.

## Funktionen

- **Wochenplan**: Mo–So mit Navigation zwischen den Wochen, «Heute» hervorgehoben.
  Gerichte pro Tag eintragen, als gekocht abhaken, Notizen ergänzen, Datum verschieben.
- **Gerichte-Sammlung**: nach Kategorien (Teigwaren, Kartoffeln, Reis, Weitere, Desserts …),
  Suche, Favoriten, Notiz/Rezept-Link, «zuletzt gegessen vor …».
- **Wochenende / unter der Woche**: pro Gericht einstellbar. Beim Planen eines Tages werden
  passende Gerichte angezeigt (umschaltbar), Vorschläge berücksichtigen den Tag.
- **Zutaten & Einkaufsliste 🛒**: pro Gericht eine Zutatenliste mit Mengen. Nach dem Einplanen
  wählt man aus, welche Zutaten in den gemeinsamen Warenkorb kommen (bereits vorhandene sind
  abgewählt). In der Einkaufsliste abhaken, eigene Artikel ergänzen, Erledigtes entfernen.
- **Vorschlag 🎲**: schlägt Gerichte vor, die ihr länger nicht mehr gegessen habt,
  und plant sie mit einem Tipp für den nächsten freien Tag ein.
- **Gemeinsame Daten**: beide melden sich mit eigenem Konto an und sind über einen
  Beitrittscode im selben Haushalt. Änderungen erscheinen sofort auf allen Geräten.
- Startdaten aus den bisherigen Notizen (Gerichte-Liste und letzter Menüplan) werden beim
  Erstellen des Haushalts automatisch übernommen.

## Technik

- Reines HTML/CSS/JavaScript ohne Build-Schritt (`index.html`, `app.js`, `style.css`).
- Backend: Supabase (Projekt «Tulpenweg-Sanierung»), Tabellen mit Präfix `menu_`.
  Schema inkl. Row Level Security: `supabase/migrations/`.
- Hosting: GitHub Pages über `.github/workflows/pages.yml`.

## Einrichtung

1. **GitHub Pages aktivieren**: Repository → *Settings* → *Pages* → *Source*: «GitHub Actions».
   Danach den Workflow «Auf GitHub Pages veröffentlichen» (erneut) laufen lassen.
   Die App ist dann unter `https://mikesch15.github.io/Menuverwaltung/` erreichbar.
2. **Supabase-Weiterleitung erlauben** (für Bestätigungs- und Passwort-Mails):
   Supabase → *Authentication* → *URL Configuration* → *Redirect URLs* →
   `https://mikesch15.github.io/Menuverwaltung/**` hinzufügen.
3. In der App registrieren bzw. anmelden → «Neuen Haushalt erstellen»
   (Häkchen bei «aus bisherigen Notizen übernehmen» lassen).
4. Unter *Einstellungen* den **Beitrittscode** an die Partnerin schicken. Sie registriert sich
   und gibt den Code unter «Haushalt beitreten» ein.
5. Auf dem Handy im Browser «Zum Startbildschirm hinzufügen» wählen.

## Lokal testen

```sh
python3 -m http.server 8000
# http://localhost:8000
```
