# Gift Card Wallet

A mobile-first web app to import gift card QR codes from PDFs and use them at the shop. Everything runs in the browser — no server, no upload.

## Features
- **Import PDFs** — scans every page, extracts QR codes, auto-detects the dollar value from the page text (`$50`, `Value: 30`, `25 USD`, etc.). Falls back to a manual prompt with quick-select chips if nothing is detected.
- **Tap a card** to maximise the QR code full-screen for the cashier to scan.
- **Per-card toggle** to mark a card as used. Total balance at the top instantly updates.
- **Group by value** button stacks cards of the same value (`$10`, `$30`, `$50`…). Used cards slide to the back of the stack.
- **Local-only storage** — cards live in your browser's `localStorage`. Backup / restore via JSON in the settings menu.
- **Installable** as a PWA on iOS / Android (Add to Home Screen).

## Run it
It's static — no build step.

```bash
# Any static server works. For example:
python3 -m http.server 8080
# then open http://localhost:8080
```

Or just open `index.html` directly in a modern browser (some browsers restrict PDF.js workers under `file://`, so a local server is safer).

## How value detection works
After QR scanning, the app reads the PDF's text layer for the page and tries patterns like:
- `Value: $30`, `Amount 50`, `Balance £25`
- `$30`, `€50`, `£10`
- `30 dollars`, `50 USD`

If none match, you get a prompt with quick chips ($10 / $20 / $25 / $30 / $50 / $100) and a numeric input.

## Tech
- Vanilla HTML/CSS/JS, no framework, no build.
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering + text extraction.
- [jsQR](https://github.com/cozmo/jsQR) for QR detection on rendered canvases (multi-scale + tile scan for multiple QRs per page).
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) to redraw a crisp SVG QR from the decoded payload.

## Privacy
All PDFs are processed in your browser. Nothing is uploaded.
