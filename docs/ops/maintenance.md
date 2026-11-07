# Maintenance page and self-hosted deploys (#326)

This covers the self-hosted site, where a Cloudflare tunnel reaches `jobflow.service` on this host. Visitors see a "We'll be back soon" page while a deploy runs and whenever the app can't be reached. API calls get a JSON `503` with `Retry-After`.

The staging Compose stack has its own steps in [deployment.md](deployment.md) and doesn't use this page yet.

## How it works

- nginx listens on `127.0.0.1:3299` and forwards to the app on `127.0.0.1:3300`. The tunnel points at nginx.
- **Maintenance on:** while `/var/lib/jobflow-maintenance/on` exists, nothing reaches the app.
- **App down:** if nginx can't reach the app, it shows the same page. The site returns by itself when the app does.
- **What it can't cover:** if the whole host or the tunnel is down, Cloudflare shows its own error, because nothing here is running to answer.

## Install once

The owner runs this, because it needs `sudo`. It's safe to run again. First deploy a build that includes it, then:

```sh
sudo bash /home/prod/tax-invoice-run/infra/host/install.sh
```

It installs nginx and the maintenance page, a limited permission for the deploy script, and the [scheduled jobs timer](#scheduled-jobs). It also starts the database and file storage at boot (`jobflow-services.service`); the app and the timer start after them.

Then switch the tunnel: in the Cloudflare dashboard, under **Zero Trust → Networks → Tunnels**, change the public hostname's service from `http://localhost:3300` to `http://localhost:3299`. To undo this, change it back. The app itself isn't affected.

Check that the tunnel goes through nginx, because pointing it at 3300 would bypass the page:

```sh
touch /var/lib/jobflow-maintenance/on
curl -sI https://jobflow.shivomsangha.com/ | head -1   # expect 503
rm -f /var/lib/jobflow-maintenance/on
curl -sI https://jobflow.shivomsangha.com/ | head -1   # expect 200 or a redirect
```

nginx holds an upload on disk before passing it to the app, so keep at least a few hundred MB free on the system disk.

## Deploy

Check first, as in [deployment.md](deployment.md#before-you-deploy): `main` is green on the exact commit, the migrations are understood, and a backup has been taken. The owner approves each deploy. Then, as `prod`:

```sh
cd /home/prod/tax-invoice-run && git fetch origin main
bash <(git show origin/main:infra/host/deploy.sh) "$(git rev-parse origin/main)"
```

The script runs these steps in order:

1. Refuses anything but the tip of `origin/main`, changing nothing.
2. Turns maintenance on.
3. Stops the app, so old code can never serve requests against a newer database.
4. Checks out the commit, installs, migrates and builds.
5. Starts the app and polls its readiness directly on port 3300, for up to about 2 minutes.
6. Turns maintenance off only after readiness passes.

If any step fails, **maintenance stays on** and the script says so. Fix the problem or roll back ([deployment.md](deployment.md#roll-back)), then turn it off by hand.

## Turn it on or off by hand

```sh
touch /var/lib/jobflow-maintenance/on   # on
rm -f /var/lib/jobflow-maintenance/on   # off
```

From a checkout, `infra/host/maintenance.sh on|off|status` does the same. The change takes effect on the next request, with no restart.

Check what visitors see, and whether the app itself is ready:

```sh
curl -sI http://127.0.0.1:3299/ | head -1           # 503 means the page is showing
curl -sS http://127.0.0.1:3300/api/health/ready     # the app, bypassing the page
```

## Scheduled jobs

`jobflow-jobs.timer` runs `pnpm jobs:run` every 5 minutes, and catches up after downtime. Today it queues the trial reminder emails, and the app's outbox sweep sends them. It's skipped while maintenance is on, and running it twice sends nothing twice.

```sh
systemctl list-timers jobflow-jobs.timer                 # when it last ran and runs next
journalctl -u jobflow-jobs.service -n 50 --no-pager      # results and failures
sudo systemctl disable --now jobflow-jobs.timer          # stop it
```

Each run logs how many reminders it queued and how many emails are pending or failed. A growing `failed` count means email isn't going out, so check the `email.send_failed` lines in `journalctl -u jobflow.service`.

## Test it

`infra/host/test-gate.sh [path to nginx]` runs real nginx with a fake app on spare ports and needs no root. It covers maintenance on and off, the app stopped, a refused commit, a failed readiness check and a good deploy. CI doesn't run it, so run it after changing anything in `infra/host/`. `tests/unit/host-gate.test.ts` checks the settings the app relies on.
