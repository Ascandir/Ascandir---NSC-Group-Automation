# Ascandir - NSC Group Automation

Foundry VTT v13/v14 · dnd5e 5.x/6.x · nur für den DM

NSC-Gruppen sammeln die besten Werte ihrer Mitglieder und werden über ein **Missionsboard** auf vorbereitete Missionen geschickt. Ein Klick auf **Auflösen** berechnet die Erfolgschance, würfelt aus, vergibt die Belohnung und wendet die Folgen an.

## Einrichtung

1. Im Actors-Tab einen Actor vom Typ **Gruppe** anlegen (z. B. „Bastion – Späher“).
2. Die NSCs (NPC-Actors) per Drag & Drop in die Gruppe ziehen.
3. Missionsboard öffnen: Knopf **Missionsboard** oben im Actors-Tab – oder Einstellungen → Moduleinstellungen → „Missionsboard öffnen“.

## So wird gerechnet

| Schritt | Regel |
|---|---|
| Gruppenwert | Pro Fertigkeit, Attribut und Rettungswurf zählt der **höchste** Bonus eines lebenden Mitglieds. |
| Gruppenstufe | Durchschnitt der **HG (CR)** aller lebenden Mitglieder. |
| Chance pro Probe | Wahrscheinlichkeit, mit W20 + Gruppenbonus den SG zu schaffen (z. B. +7 gegen SG 15 = 65 %). |
| Grundchance | Durchschnitt aller Proben (ohne Proben: 50 %). |
| Stufenunterschied | ±5 % pro Stufe über/unter der Missionsstufe (in den Einstellungen änderbar). |
| Erfolgschance | Begrenzt auf 5–95 %, dann umgerechnet in einen **Ziel-SG**: hohe Chance = niedriger SG. |
| Wurf | 1W20 gegen den Ziel-SG. |

## Ergebnisse

- **Erfolg** – Wurf ≥ Ziel-SG: volles Gold + alle Gegenstände landen in der Gruppe.
- **Teilerfolg** – knapp verfehlt (Standard: bis 3 darunter): anteiliges Gold (Standard 50 %), keine Gegenstände.
- **Misserfolg** – keine Belohnung, Gruppe ist X Tage verletzt und kann keine Mission annehmen.
- **Katastrophe** – natürliche 1 oder 10+ unter dem Ziel-SG: doppelte Verletzungsdauer; wenn in der Mission erlaubt, stirbt ein zufälliges Mitglied (Status „tot“, zählt nicht mehr mit).

Die Verletzungsdauer läuft über die Spielzeit (Kalender/Zeit vorspulen). Mit **Freigeben** auf dem Board ist die Gruppe sofort wieder bereit. Tote NSCs zählen wieder mit, sobald du ihren Status „tot“ entfernst.

## Makro

```js
game.modules.get("ascandir-nsc-group-automation").api.openBoard()
```
