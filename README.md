# BSE Dividend Calendar + 30-Minute Telegram Alerts

The Angular UI and existing Telegram alert format are retained. The scheduled monitor runs every 30 minutes from GitHub Actions.

## Data-source reliability (BSE only)

1. **Only corporate-action source:** BSE `DefaultData/w` using `strSearch=S`. No alternate exchange is queried for dividend announcements or share prices.
2. **Retries:** Transient network, timeout, HTTP 429/5xx, invalid JSON, and HTML responses retry with exponential backoff and jitter. HTTP 401/403 fails fast after detection rather than repeatedly hammering the blocked endpoint.
3. **No false success:** If BSE is blocked or returns invalid data after retries, the workflow exits non-zero, sends one outage alert when Telegram is available, and preserves the last good UI cache and dividend state. A valid BSE response containing an empty array is treated as a valid empty result.
4. **Recovery:** When BSE becomes available again, the monitor checks a 30-day lookback plus the next 60 days, processes unseen events, and sends a recovery alert. It retains 90 days of event keys so recently expired announcements are not repeatedly alerted.
5. **Deduplication:** Event keys use BSE code, record date, and purpose. State is saved after each delivered dividend alert.
6. **Price lookup:** BSE quote first, then Yahoo Finance's BSE `.BO` ticker only. If no price is available, yield is shown as `-`.

**Coverage limitation:** BSE-only means announcements unavailable from BSE cannot be sourced elsewhere. No code can guarantee uninterrupted access when BSE blocks the runtime; for contractual uptime, use an authorized BSE data-access arrangement. The bot preserves state and reports an outage rather than treating a blocked response as “no new dividends.”

## GitHub Actions setup

Create repository secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

The workflow `.github/workflows/dividend-alert.yml` runs every 30 minutes and can also be started manually. It uses `npm ci` and commits `data/dividend-state.json` and `data/latest-dividends.json` back to the repository. Ensure Actions are enabled and the repository's Actions `GITHUB_TOKEN` has read/write access to repository contents.

## Local UI

```bash
npm ci
npm start
```

Open `http://localhost:4200`.

## Local mock tests

```bash
npm run test:server
```

The test suite uses mocked provider and Telegram responses; it does not claim live BSE or Telegram delivery was verified.

For a local mock monitor run:

```bash
# macOS/Linux
BSE_MOCK=1 TELEGRAM_MOCK=1 npm run dividend:check
```

```powershell
# Windows PowerShell
$env:BSE_MOCK="1"
$env:TELEGRAM_MOCK="1"
npm run dividend:check
```

## Vercel data architecture

The Angular UI reads `/api/dividends`. The 30-minute GitHub Actions job writes the last successful snapshot to `data/latest-dividends.json`; the Vercel API serves that cache if a live BSE request is unavailable. The UI remains independent of provider network behavior from Vercel.
