# Deploy Proctoring AI to a DigitalOcean Droplet (free, HTTPS, no domain)

A minimal end-to-end guide to get the full stack online for a 5-6 student
pilot. Uses your GitHub Student Pack DigitalOcean credit (`$200`) and the
free `nip.io` DNS service so you do **not** need to buy a domain.

When you finish, three URLs will be live:

| URL | Serves |
| --- | --- |
| `https://<ip-dashes>.nip.io` | Student web app |
| `https://admin.<ip-dashes>.nip.io` | Admin web app |
| `https://api.<ip-dashes>.nip.io` | FastAPI backend (REST + WebSocket) |

Each gets a real Let's Encrypt cert automatically. Cost: **$0** for the
duration of the test (under your DO credit).

---

## 1. Prerequisites (one-time, ~5 min)

1. **Claim your DigitalOcean credit** via
   [education.github.com/pack](https://education.github.com/pack) -> DigitalOcean.
2. **Generate an SSH key** on your Windows laptop if you don't have one:
   ```powershell
   ssh-keygen -t ed25519 -C "you@example.com"
   ```
   Press Enter through the prompts. The public key lands at
   `C:\Users\<you>\.ssh\id_ed25519.pub`. Open it in Notepad and copy.
3. **Add the SSH key to DigitalOcean** -> Settings -> Security -> Add SSH key,
   paste, give it a name.

---

## 2. Create the Droplet (~2 min)

1. DigitalOcean dashboard -> **Create -> Droplet**.
2. **Image**: Ubuntu 22.04 (LTS) x64.
3. **Region**: pick the one closest to your students (Bangalore / Singapore
   for South Asia, Frankfurt for Europe, NYC for US east, etc.).
4. **Droplet type**: **Basic -> Regular -> 4 GB / 2 vCPU / 80 GB SSD ($24/mo)**.
   The 2 GB plan **will OOM** when DeepFace loads. The 8 GB plan is nicer if
   you can spare the credit (~4 months runway instead of ~8).
5. **Authentication**: SSH key (select the one you just added).
6. **Hostname**: `proctor-pilot` (or anything).
7. Click **Create Droplet**.

After ~30 s you get a **public IPv4** like `167.99.45.12`. **Write it down.**

> Your `PUBLIC_HOST` is that IP with dots replaced by dashes plus `.nip.io`,
> e.g. **`167-99-45-12.nip.io`**.

---

## 3. SSH in and install Docker (~3 min)

From PowerShell on your laptop:

```powershell
ssh root@167.99.45.12       # your IP, type "yes" to trust on first connect
```

Inside the Droplet:

```bash
# System update
apt-get update && apt-get -y upgrade

# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
apt-get install -y docker-compose-plugin git

# Confirm
docker version
docker compose version
```

> The `docker-compose.prod.yml` in this repo uses the v1 `docker-compose`
> command syntax. If you only have the v2 plugin, run **`docker compose -f
> docker-compose.prod.yml ...`** (space, no dash). Both work identically
> for our config.

---

## 4. Open the firewall (~1 min)

If you enabled DigitalOcean's cloud firewall, open ports 80 and 443. If
you're using the default Ubuntu UFW:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

Nothing else should be open to the internet. Postgres, Redis, MinIO,
Adminer all stay on the private Docker network.

---

## 5. Clone the project (~1 min)

```bash
cd /opt
git clone https://github.com/<your-username>/<your-repo>.git proctoring-ai
cd proctoring-ai
```

> If the repo is private, either generate a deploy key or use a short-lived
> personal access token: `git clone https://<TOKEN>@github.com/...`.

---

## 6. Configure the environment (~3 min)

```bash
cp .env.production.example .env
nano .env                       # or vim, or use VS Code Remote-SSH
```

Replace:

| Variable | Value |
| --- | --- |
| `PUBLIC_HOST` | `167-99-45-12.nip.io` (your IP with dashes) |
| `LETSENCRYPT_EMAIL` | A real mailbox (used for cert-expiry alerts) |
| `POSTGRES_PASSWORD` | Run `openssl rand -base64 24` and paste |
| `JWT_SECRET_KEY` | Run `openssl rand -hex 32` and paste |
| `SECRET_KEY` | Same value as `JWT_SECRET_KEY` |
| `MINIO_ROOT_PASSWORD` | Another `openssl rand -base64 24` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Your admin login |

Save and exit.

---

## 7. Build and launch (~10-15 min)

The first build is **slow** - the backend image downloads PyTorch,
TensorFlow, and the VGG-Face weights (~550 MB). Subsequent rebuilds are
fast because Docker caches each layer.

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

Watch progress:

```bash
docker compose -f docker-compose.prod.yml logs -f backend
```

You'll see Postgres come up, then MinIO, then the backend will pull and
load the ML models. **Wait for the line `DeepFace VGG-Face model ready`**
followed by gunicorn's `Application startup complete`. That's "live."

In parallel, Caddy will request certs from Let's Encrypt - takes ~30 s
the first time. Check it:

```bash
docker compose -f docker-compose.prod.yml logs caddy | grep -i certificate
```

You're looking for `certificate obtained successfully` for each of the
three hostnames.

---

## 8. Smoke-test (~2 min)

From your laptop, open:

- `https://167-99-45-12.nip.io` -> should load the **student** login.
- `https://admin.167-99-45-12.nip.io` -> should load the **admin** login.
- `https://api.167-99-45-12.nip.io/api/v1/settings/health` -> should return
  `{"ok": true, ...}` JSON.

Log in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. The admin SPA
should hit the backend successfully and the lock icon should be green
(real cert, not self-signed).

---

## 9. Share with students

Send them just one URL: `https://167-99-45-12.nip.io`. They sign up there
(or use the seeded accounts), grant webcam + screen-share when prompted,
and take an exam. Their webcam works because the URL is real HTTPS - no
browser warnings, no `getUserMedia` blocking.

---

## 10. Useful operations

```bash
# Tail backend logs live
docker compose -f docker-compose.prod.yml logs -f backend

# Restart only one service after a fix
docker compose -f docker-compose.prod.yml restart backend

# Rebuild a frontend after changing PUBLIC_HOST
docker compose -f docker-compose.prod.yml build admin-frontend student-frontend
docker compose -f docker-compose.prod.yml up -d admin-frontend student-frontend

# Open Adminer (DB GUI) over an SSH tunnel from your laptop:
#   ssh -L 8081:127.0.0.1:8081 root@167.99.45.12
# then visit http://localhost:8081  (server=db, user/pw from .env)

# Free disk space (Docker can hoard old images / layers)
docker system prune -a --volumes        # WARNING: deletes unused volumes
```

---

## 11. When the test ends - stop billing

If you want to keep the data but pause the bill: **Droplets are billed by
the hour while running OR while powered-off but still allocated.** The only
way to fully stop billing is to **destroy** the Droplet (snapshot first if
you want to resurrect it later).

```bash
# Snapshot (optional, costs a few cents/month while stored):
#   In DO dashboard -> Droplet -> Snapshots -> Take Snapshot
# Then:
```
Destroy via DO dashboard -> Droplet -> Destroy.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Caddy logs say `no IP address found for ...nip.io` | Typo in `PUBLIC_HOST`. Use dashes not dots, no leading subdomain. |
| Cert request fails with `connection refused on :80` | Cloud firewall or UFW blocks 80. Re-run step 4. |
| Backend keeps restarting, OOMKilled | Droplet is the 2 GB plan. Resize to 4 GB+ (DO dashboard -> Resize). |
| `https://...nip.io` loads but webcam blocked | Cert is invalid / self-signed. Check `caddy logs`. Until Caddy gets a real cert from Let's Encrypt, browsers won't grant `getUserMedia`. |
| Backend logs say `DeepFace weights truncated` | The image build was interrupted. `docker compose build --no-cache backend` to redownload. |
| Browser console: `Mixed Content` blocked | Frontend was built with an http:// URL. Re-check the `VITE_*` args in `docker-compose.prod.yml` are all `https://` / `wss://`, then `docker compose build admin-frontend student-frontend`. |
| Hit Let's Encrypt rate limit while testing | Edit `Caddyfile`, uncomment the `acme_ca` staging line, `docker compose restart caddy`. Don't ship to students with staging certs - they're untrusted. |
