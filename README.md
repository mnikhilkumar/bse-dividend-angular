# BSE Dividend Calendar + 30 Minute Telegram Alerts

## UI

The Angular UI displays BSE dividend companies for today through the next 60 days, latest price, record date, dividend/share and dividend yield.

## Telegram alert logic

Every 30 minutes the GitHub Actions workflow:

1. Fetches today's through next 60 days BSE dividend data.
2. Removes stored events whose record date is before today.
3. Compares current BSE events with `data/dividend-state.json`.
4. Sends Telegram only for a new event.
5. Stores the event after Telegram succeeds.
6. Refreshes latest price/yield for existing events without sending duplicate alerts.
7. Commits the state file back to GitHub.

Unique event key:

`BSE Code + Record Date + Purpose`

This means the same dividend announcement is not sent repeatedly on later 30-minute runs.

## GitHub setup

Create repository secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then enable Actions. The workflow is `.github/workflows/dividend-alert.yml` and can also be started manually with **Run workflow**.

## Local UI

```bash
npm install
npm start
```

Open `http://localhost:4200`.

## Local alert test

Use mock BSE + mock Telegram:

Windows CMD:

```cmd
set BSE_MOCK=1
set TELEGRAM_MOCK=1
npm run dividend:check
```

PowerShell:

```powershell
$env:BSE_MOCK="1"
$env:TELEGRAM_MOCK="1"
npm run dividend:check
```

## Server test

```bash
npm run test:server
```


## Vercel data architecture
The Angular UI reads `/api/dividends`. The Vercel API serves the last successful BSE dividend snapshot written by the 30-minute GitHub Actions job to `data/latest-dividends.json`. This keeps the UI independent of BSE network behavior from Vercel. A fresh deployment can temporarily fall back to a live BSE request until the first successful workflow refresh.
