# Vercel API fix

The Angular UI calls `/api/dividends`, but the previous deployment only published the Angular static build. These Vercel serverless functions expose the existing Node BSE backend at the same origin.

Copy the `api/` folder into the project root and push to `main`. Vercel will automatically deploy the functions.

Test after deployment:
- `/api/health`
- `/api/dividends?Fdate=20260920&TDate=20261119`
