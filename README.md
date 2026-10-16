# Farmingdale Tuesday showtimes

Find movies starting between **5:00 PM and 7:00 PM, inclusive**, at **Showcase Cinema de Lux Farmingdale (`X00UF`)** on the upcoming Tuesday.

Requires Node.js 18.17 or newer. Showtimes can be checked without packages, an account, cookies, browser automation, or an API key. Optional Gmail delivery uses the `dotenv` and `nodemailer` packages.

## Run

Open a terminal in this folder and run:

```powershell
node showcase.mjs
```

The script prints each matching movie, start time, XPlus or Non-XPlus label, screen, and booking link on one line per showing. XPlus is identified by the site's `Internal.Brand.Xplus` showtime tag. Email uses the same layout. Times use `America/New_York`: EDT in summer and EST in winter. They are the theater's local clock times, rather than fixed UTC-5 throughout the year.

On Tuesdays, the script selects today's showtimes before and during the selected time window. Once the window ends, it selects the following Tuesday. With the default 5–7 PM window, Tuesday morning, 5 PM, and exactly 7 PM all select today; any time after 7 PM selects next Tuesday. The cutoff follows `--end` and uses the theater's Eastern time, including daylight saving time. On other days, it selects the next Tuesday.

Use `--include-today` to force the current Tuesday even after the window ends. An explicit `--date` overrides automatic date selection. Shows marked expired by the site are excluded as before.

```powershell
node showcase.mjs --date 2026-10-20
node showcase.mjs --include-today
node showcase.mjs --json
node showcase.mjs --start 17:30 --end 19:00
```

JSON output includes the date, theater, timezone, retrieval time, source, status, and individual showtimes. Status is `ok`, `no_matches`, or `no_schedule`. `no_schedule` means the service returned no showtimes for that date; the schedule may not be published yet. It does not prove the theater is closed. Request errors, unexpected response structures, and missing movie titles print an error to standard error and exit with code 1. Successful lookups, including empty schedules, exit with code 0.

No recurring job has been installed. The script can be called from a scheduler later; Node.js, internet access, and the email configuration must be available to that job.

## Send results through Gmail

Install the email dependencies and create your local configuration:

```powershell
npm install
Copy-Item .env.example .env
```

Fill in `.env` beside `showcase.mjs`:

```dotenv
GMAIL_USER=your-address@gmail.com
GMAIL_APP_PASSWORD="your Google App Password"
EMAIL_TO=recipient@example.com,another-recipient@example.com
```

Use your full Gmail address as `GMAIL_USER`. Enable Google **2-Step Verification**, then generate a separate **App Password** at [Google App Passwords](https://myaccount.google.com/apppasswords). Use that password here, rather than your normal Google account password. Spaces in the generated password are removed automatically. Some accounts do not offer App Passwords; see [Google's requirements](https://support.google.com/accounts/answer/185833). This script uses Gmail SMTP with TLS on port 465, as supported by [Nodemailer's Gmail integration](https://nodemailer.com/guides/using-gmail).

`EMAIL_TO` accepts one or more plain email addresses separated by commas. The sender is `GMAIL_USER`. All recipients are visible in the To field. `.env` and other local `.env.*` files are excluded from Git; `.env.example` contains no credentials. Keep your App Password in the local file.

Preview the complete email without contacting Gmail, then send it:

```powershell
node showcase.mjs --email --dry-run
node showcase.mjs --email
```

Or use `npm run email`. Each invocation with `--email` sends one message containing that lookup's results and booking links, including a clear message when no matching showtimes or published schedule were returned. Lookup errors stop the run without sending an email. Gmail errors and partial recipient rejection exit with code 1. Messages are not automatically resent after a delivery error; check Sent mail before retrying to avoid duplicates. Gmail accepting the message does not guarantee inbox delivery.

All date and time flags work with email, for example:

```powershell
node showcase.mjs --email --start 17:30 --end 20:00
node showcase.mjs --email --env-file 'C:\path\to\private.env'
```

The default `.env` path is beside the script, independent of the terminal's working directory. An explicit `--env-file` path is relative to the working directory unless absolute. Existing environment variables override values in the file. `--dry-run` and `--env-file` require `--email`. Normal runs without `--email` only print results. With `--json`, standard output remains JSON; email previews and delivery confirmations go to standard error. Archive results can also be previewed or emailed using `--har` and are clearly labeled as saved data.

## The requests

We use these two read-only GET endpoints under `https://www.showcasecinemas.com`:

1. `/api/gatsby-source-boxofficeapi/schedule` returns showtimes grouped by theater ID, movie ID, and date.
2. `/api/gatsby-source-boxofficeapi/movies` returns movie titles for repeated `ids` parameters.

For October 20, 2026, the decoded schedule parameters are:

```text
from=2026-10-20T03:00:00
theaters={"id":"X00UF","timeZone":"America/New_York"}
to=2026-10-21T03:00:00
```

`scheduleUrl()` URL-encodes these parameters. The 03:00 boundaries reproduce the website's request; no `Z` or UTC conversion is added. Captured `startsAt` values such as `2026-10-20T18:10:00` are theater-local. The script filters that response to the requested calendar date and time window, then requests titles for only the matching movie IDs:

```text
/api/gatsby-source-boxofficeapi/movies?basic=false&castingLimit=3&ids=MOVIE_ID_1&ids=MOVIE_ID_2
```