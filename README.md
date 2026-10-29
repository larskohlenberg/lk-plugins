# lk-plugins

Persönlicher Marktplatz für Claude-Code-Plugins. Öffentlich: Jede und jeder kann sie installieren und nutzen (MIT-Lizenz).

In der Desktop-App, wo `/plugin` nicht läuft: **+** neben dem Eingabefeld → **Plugins** → **Add marketplace** mit `larskohlenberg/lk-plugins` → **Add plugin**.

Braucht eine Claude-Code-Version mit Mod-Unterstützung (gebaut und getestet mit 2.1.309); die Mod-Schnittstelle ist Early Access und kann sich ändern.

> Früher eigenständig: [dictation-cleanup](https://github.com/larskohlenberg/dictation-cleanup) ist jetzt Teil von **cockpit**.

## Installation (einmal pro Rechner)

```bash
claude plugin marketplace add larskohlenberg/lk-plugins
claude plugin install cockpit@lk-plugins
```

## Update (wenn eine neue Version im Repo liegt)

```bash
claude plugin marketplace update lk-plugins
claude plugin update cockpit@lk-plugins
```

Der erste Befehl holt den neuesten Stand aus GitHub, der zweite installiert die neue Version. Danach Claude Code neu starten.

## cockpit

Leiste über dem Eingabefeld (Desktop-App und Terminal):

- **Cache-Keeper**: farbiger Punkt mit Cache-Countdown (60 min; grün, gelb ab 5 min Rest, rot = abgelaufen), geschätzte Rewrite-Kosten, 5h-/Wochenlimit, Session-Kosten; Hinweis 5 min vor Ablauf.
- **[h] ↪ Handoff / [c] ⟳ clear & continue**: Handoff schreiben, dann `/clear` und in frischer Session fortsetzen.
- **[f] ✓ fertig**: Session abschließen.
- **[d] 🎙 / 🔇 Diktat-Aufbereitung**: Diktierte Prompts (ab 40 Zeichen) schreibt Haiku vor dem Senden in einen klaren Prompt um; eingefügter Code und Logs bleiben unverändert. Der Knopf schaltet sie an (🎙) oder aus (🔇), ebenso `/dictation-cleanup on | off | status`. Die Einstellung bleibt über Sessions erhalten. Wortliste und bekannte Hörfehler stehen oben im Diktat-Teil von `hooks/register.tsx` (`VOCABULARY`, `MISHEARINGS`).
- Fährst du mit der Maus über einen Knopf, zeigt die Leiste links, was er tut (statt Tooltip).
- Knöpfe anderer Mods erscheinen links neben diesen Knöpfen.
- **Handoff-Angebot**: Beim Start einer Session in einem Projekt wird der neueste ungenutzte Handoff aus `.claude/handoffs/` angeboten ([w] ▶ weitermachen, [x] ✕ ignorieren).
- **handoff-Skill**: speichert in Projekten unter `.claude/handoffs/`, sonst im Temp-Ordner.

Tipp: `**/.claude/handoffs/` in die globale Git-Ignore-Datei aufnehmen.
