# BSE-only reliability update

The project uses BSE as its only corporate-action source. It validates HTTP status, HTML/access-denied responses, JSON shape, BSE scrip codes, and dividend-purpose fields. Transient failures use exponential backoff. HTTP 401/403 is reported as a source outage rather than being treated as an empty dividend result.

When BSE is unavailable, the monitor preserves the previous saved state and UI cache, sends a single outage notification when possible, and retries on the next scheduled run. When BSE recovers, it checks the lookback window, alerts only on unseen events, and sends a recovery notice. Local mock tests do not prove live BSE access or Telegram delivery from GitHub Actions.
