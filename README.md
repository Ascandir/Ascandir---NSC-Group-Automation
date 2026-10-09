# Ascandir - NSC Group Automation

Foundry VTT v13/v14 · dnd5e 5.x/6.x · nur für den DM

NSC-Gruppen sammeln die besten Werte ihrer Mitglieder und werden über ein **Missionsboard** auf vorbereitete Missionen geschickt. Der DM entsendet die Gruppe, sie ist dann **unterwegs**, und beim **Auflösen** wird automatisch gewürfelt, belohnt oder bestraft.

## Installation

Manifest-URL in Foundry (Module installieren):

```
https://github.com/Ascandir/Ascandir---NSC-Group-Automation/releases/latest/download/module.json
```

## Einrichtung

1. Im Actors-Tab einen Actor vom Typ **Gruppe** anlegen (z. B. „Jäger der Bastion“).
2. Die NSCs (NPC-Actors) per Drag & Drop in die Gruppe ziehen.
3. Missionsboard öffnen: Knopf **Missionsboard** oben im Actors-Tab – oder Einstellungen → Moduleinstellungen → „Missionsboard öffnen“.

## Ablauf

1. **Mission anlegen**: Stufe, Proben mit SG, Belohnung, Folgen bei Misserfolg.
2. **Gruppe wählen** und **Entsenden** → Status „Unterwegs“. Eine Gruppe kann immer nur auf einer Mission sein. Mit dem Rückruf-Knopf holst du sie ohne Ergebnis zurück.
3. **Auflösen** → Wurf, Ergebnis im Chat, Gruppe ist wieder zu Hause.

## So wird gerechnet

| Schritt | Regel |
|---|---|
| Gruppenwert | Pro Fertigkeit, Attribut und Rettungswurf zählt der **höchste** Bonus eines einsatzbereiten Mitglieds. |
| Gruppenstufe | Durchschnitt der **HG (CR)** aller einsatzbereiten Mitglieder. |
| Chance pro Probe | Wahrscheinlichkeit, mit W20 + Gruppenbonus den SG zu schaffen (z. B. +7 gegen SG 15 = 65 %). |
| Grundchance | Durchschnitt aller Proben (ohne Proben: 50 %). |
| Stufenunterschied | ±5 % pro Stufe über/unter der Missionsstufe (Einstellung). |
| Erfolgschance | Begrenzt auf 5–95 %, dann umgerechnet in einen **Ziel-SG**: hohe Chance = niedriger SG. |
| Wurf | 1W20 gegen den Ziel-SG. |

Verletzte und tote Mitglieder zählen nicht mit.

## Belohnung

- **Gold** von – bis.
- **Garantierter Loot**: beliebige Gegenstände (per Drag & Drop) mit Menge von – bis, z. B. 1–100 Fleisch, 1–200 Felle. Kommt bei Erfolg immer mit.
- **Möglicher Loot**: Gegenstände mit Chance in % und Menge von – bis.
- **Überschuss**: Jeder Punkt über dem Ziel-SG schiebt die Mengen Richtung Maximum und erhöht die Loot-Chancen (Standard +5 % pro Punkt). Beispiel: Ziel-SG 3, Wurf 10 → +7 → +35 %.
- Alles landet in der Gruppe; gleiche Gegenstände werden gestapelt.

## Ergebnisse

- **Erfolg** – Wurf ≥ Ziel-SG: volle Beute inkl. möglichem Loot.
- **Teilerfolg** – knapp verfehlt (Standard: bis 3 darunter): anteilig Gold und garantierter Loot (Standard 50 %), kein möglicher Loot.
- **Misserfolg** – keine Beute. Alle beteiligten Mitglieder verlieren TP (Standard 25 % der max. TP, nie unter 1) und bekommen den Status **Verletzt (Mission)** für X Tage.
- **Katastrophe** – natürliche 1 oder 10+ unter dem Ziel-SG: doppelter TP-Verlust und doppelte Dauer; wenn erlaubt, stirbt ein zufälliges Mitglied (0 TP, Status **tot**).

## Wiederholbare Missionen

Im Editor unter **Wiederholbar** den Haken setzen und eine Zeitspanne (Stunden, Tage oder Wochen) angeben. Nach dem Auflösen läuft die Zeit über die Spielzeit; danach steht die Mission automatisch wieder auf **Offen** und kann neu vergeben werden. Auf dem Board steht, wann sie wieder verfügbar ist.

## Freigabe für Spieler

- Auf dem DM-Board hat jede Mission und jede Gruppe ein **Auge**: Damit gibst du sie für Spieler frei oder verbirgst sie wieder.
- Spieler sehen bei Missionen: Name, Stufe, „Beschreibung für Spieler“, gefragte Proben (ohne SG), Belohnung (Zusatz-Loot nur als „mögliche Zusatzbeute“), Status und Gruppe. Notizen, SG und Chancen bleiben geheim.
- Spieler sehen bei Gruppen: Mitglieder mit Status (bereit, verletzt, tot), Ø-Stufe und ob die Gruppe unterwegs ist.
- Einstellung **Missionsboard für Spieler im Actors-Tab**: zeigt Spielern den Missionsboard-Knopf im Actors-Tab.

## Custom Objekt: Missionsboard

1. Im Actors-Tab einen Actor vom Typ **Custom Objekt** anlegen, Objekttyp **Missionsboard**.
2. Den Actor als Token auf eine Szene ziehen (z. B. ans Schwarze Brett der Bastion).
3. Spieler öffnen das Board per **Doppelklick auf den Token**.
4. Funktioniert, solange in den Moduleinstellungen **Missionsboard-Objekt aktiv** angehakt ist.

Neue Custom Objekte bekommen automatisch die Berechtigung „Eingeschränkt“ für alle Spieler, damit der Doppelklick funktioniert.

## Status anpassen

TP und Status werden auf den Actor **und** alle seine Token in allen Szenen übertragen.

- Auf dem Board (Gruppe → Mitglieder): Verletzung ±1 Tag, Verletzung entfernen, Wiederbeleben (entfernt „tot“, setzt mindestens 1 TP).
- Oder direkt am Token über das Token-HUD: „tot“ bzw. „Verletzt (Mission)“ an- oder abwählen – wird automatisch auf Actor und die übrigen Token übertragen.
- Abgelaufene Verletzungen verschwinden automatisch, sobald die Spielzeit weiterläuft.

## Makro

```js
game.modules.get("ascandir-nsc-group-automation").api.openBoard()
```
