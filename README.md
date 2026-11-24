# REDLINE — Daily Bug-Solving Speedrun

**Play today's 3-round run:** https://redline.playredline.workers.dev

REDLINE is a daily 3 round code-debugging speedrun for students and developers across **Python**, **C++**, **Java**, and **SQL**. Spot the broken line, patch it inline (or diagnose why it fails), and beat the clock.

![REDLINE Preview](./og-image.png)

## How It Works
- **3 rounds per day** (Warm-Up, Core, Boss) per language.
- **Tap the broken line**, then rewrite the fix inline with Tab to autofill tokens or pick the root cause.
- **Penalties & Mistake Bank:** Wrong taps add `+3.0s`, nudges add `+5.0s`, and missed bugs save automatically to a cheat sheet.
- **Offline-first:** Built with vanilla JS, Tailwind CSS, and a service worker so it works without a connection.

## Run Locally
```bash
python3 -m http.server 8000