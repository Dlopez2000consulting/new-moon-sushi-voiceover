# New Moon Sushi — VoiceOver sessions

Real macOS VoiceOver sessions (Guidepup + Playwright WebKit on GitHub Actions `macos-15`) against the published
www.newmoonsushi.com as it is on the session date: the baseline (28 October 2026, 4 templates) and the verification
runs after remediation (all 11 pages since 13 November 2026). The transcript header line "Mode" states which (input
`mode`).

- Read-only: only GET requests reach the site (at most one per second per runner, staggered start); the site has no forms.
- Run: Actions → "VoiceOver transcripts" → Run workflow. If a runner runs out of time, lower `read_scale`.
- Each job uploads `transcripts/<page>/voiceover-transcript-webkit.txt` and a video of the session.
- `bash collect.sh <run-id>` downloads every artifact into `results/<page>/`.
