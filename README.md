# lk-plugins

Persönlicher Marktplatz für Claude-Code-Plugins.

## Installation (einmal pro Rechner)

```bash
claude plugin marketplace add larskohlenberg/lk-plugins
claude plugin install cockpit@lk-plugins
```

Updates: `claude plugin update cockpit@lk-plugins`

## cockpit

Leiste über dem Eingabefeld (Desktop-App und Terminal):

- **Cache-Keeper**: Cache-Countdown (60 min), Kontext, geschätzte Rewrite-Kosten, 5h-/Wochenlimit, Session-Kosten; Hinweis 5 min vor Ablauf.
- **[h] handoff / [c] clear & continue**: Handoff schreiben, dann `/clear` und in frischer Session fortsetzen.
- **Handoff-Angebot**: Beim Start einer Session in einem Projekt wird der neueste ungenutzte Handoff aus `.claude/handoffs/` angeboten ([w] weitermachen, [x] ignorieren).
- **Next Steps**: 2–3 Vorschläge nach jeder Antwort (Haiku); `/nextsteps on|off`.
- **handoff-Skill**: speichert in Projekten unter `.claude/handoffs/`, sonst im Temp-Ordner.

Tipp: `**/.claude/handoffs/` in die globale Git-Ignore-Datei aufnehmen.
