# Vercel API fix

The Angular UI calls `/api/dividends`, but the previous deployment only published the Angular static build. These Vercel serverless functions expose the existing Node BSE backend at the same origin.

Copy the `api/` folder into the project root and push to `main`. Vercel will automatically deploy the functions.

Test after deployment:
- `/api/health`
- `/api/dividends?Fdate=20260920&TDate=20261119`
\n\n## Vercel BSE endpoint fix\nThe `/api/dividends` Vercel function forwards `Fdate`, `TDate`, `Purposecode`, `ddlcategorys`, `ddlindustrys`, and `segment` to BSE `DefaultData/w` and uses `strSearch=S`. If BSE is unreachable from the Vercel serverless runtime, the committed `data/latest-dividends.json` snapshot is used as a fallback.\n