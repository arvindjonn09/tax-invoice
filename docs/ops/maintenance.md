# Maintenance page and self-hosted deploys (#326)

This covers the self-hosted site, where a Cloudflare tunnel reaches `jobflow.service` on this host. Visitors see a "We'll be back soon" page while a deploy runs and whenever the app can't be reached. API calls get a JSON `503` with `Retry-After`.

The staging Compose stack has its own steps in [deployment.md](deployment.md) and doesn't use this page yet.

## How it works

- nginx listens on `127.0.0.1:3299` and forwards to the app on `127.0.0.1:3300`. The tunnel points at nginx.
- **Maintenance on:** while `/var/lib/jobflow-maintenance/on` exists, nothing reaches the app.
- **App down:** if nginx can't reach the app, it shows the same page. The site returns by itself when the app does.
- **What it can't cover:** if the whole host or the tunnel is down, Cloudflare shows its own error, because nothing here is running to answer.

## Install once

The owner runs these, because they need `sudo`. The first deploy afterwards uses the script from `main`.

```sh
cd /home/prod/tax-invoice-run && git fetch origin main
sudo apt-get install -y nginx
# Ubuntu's sample site listens on every network address; JobFlow doesn't need it.
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -d -o root -g root -m 0755 /usr/share/jobflow-maintenance
sudo install -d -o prod -g prod -m 0755 /var/lib/jobflow-maintenance
for f in index.html index.json nginx-gate.conf sudoers-jobflow-deploy; do
  case "$f" in
    index.*) dir=infra/host/maintenance ;;
    *) dir=infra/host ;;
  esac
  git show "origin/main:$dir/$f" > "/tmp/$f"
done
sudo install -o root -g root -m 0644 /tmp/index.html /tmp/index.json /usr/share/jobflow-maintenance/
sudo install -o root -g root -m 0644 /tmp/nginx-gate.conf /etc/nginx/conf.d/jobflow-gate.conf
sudo visudo -cf /tmp/sudoers-jobflow-deploy
sudo install -o root -g root -m 0440 /tmp/sudoers-jobflow-deploy /etc/sudoers.d/jobflow-deploy
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3299/api/health   # expect 200
```

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

## Test it

`infra/host/test-gate.sh [path to nginx]` runs real nginx with a fake app on spare ports and needs no root. It covers maintenance on and off, the app stopped, a refused commit, a failed readiness check and a good deploy. CI doesn't run it, so run it after changing anything in `infra/host/`. `tests/unit/host-gate.test.ts` checks the settings the app relies on.
