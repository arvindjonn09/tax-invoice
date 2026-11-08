# Uptime monitoring (#357)

The public site is checked from outside this host, so a down host or tunnel is still noticed.

## How it works

- **Check:** `.github/workflows/uptime.yml` runs every 15 minutes on GitHub's servers. It runs `scripts/ops/uptime-check.sh https://jobflow.shivomsangha.com`, which asks `/api/health/ready`. The app answers 200 only when its database and file storage are ready.
- **Retries:** a failure is retried for about 2 minutes, so one dropped request doesn't alert.
- **Deploys:** the maintenance page (`503` with `"code": "maintenance"`) is waited out for up to 10 minutes.
- **When it fails:** the run fails, shows red in the repository's **Actions** tab, and GitHub emails the repository owner. GitHub doesn't email when the site recovers; the next green run shows it.

## Setup (owner, once)

1. In GitHub, under **Settings → Notifications → System → Actions**, make sure **"Send notifications for failed workflows only"** is on and email is ticked.
2. Run it once by hand to check: **Actions → Uptime check → Run workflow**.

## Limits

- **Timing:** GitHub can delay scheduled runs by several minutes when it's busy, so treat 15 minutes as approximate.
- **Inactivity:** GitHub turns off scheduled workflows after 60 days with no repository activity. A commit or a manual run turns it back on.
- **Errors inside the app:** this only checks that the site is up. The app writes errors to its log (`journalctl -u jobflow.service`). A service such as Sentry or UptimeRobot (with recovery emails and status pages) can be added later.
