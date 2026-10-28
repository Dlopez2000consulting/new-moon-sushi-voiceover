# New Moon Sushi — VoiceOver baseline

Real macOS VoiceOver sessions (Guidepup + Playwright WebKit on GitHub Actions `macos-15`) against the published
www.newmoonsushi.com, before any remediation. Templates: Home, Gallery, Sushi Menu, Contact.

- Read-only: only GET requests reach the site (at most one per second per runner, staggered start); the site has no forms.
- Run: Actions → "VoiceOver transcripts" → Run workflow. If a runner runs out of time, lower `read_scale`.
- Each job uploads `transcripts/<page>/voiceover-transcript-webkit.txt` and a video of the session.
- `bash collect.sh <run-id>` downloads every artifact into `results/<page>/`.
