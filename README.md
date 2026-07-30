# Hygd — Event & Room Schedule

A self-hosted web app that parses MECS daily resource PDF reports and displays every event on an interactive visual calendar — including room assignments, equipment/catering/setup lists, onsite contacts, and **auto-extracted room-layout diagrams**.

No external API or cloud service required. Everything runs locally on your Linux server.

---

## What it does

- **Upload a PDF** — drag-and-drop a MECS daily resource report into the browser
- **Auto-parses** every event: date, time, room, event name, onsite contact, coordinator, attendance, and the full setup/equipment list
- **Room layouts** — when a report embeds a *Room Set Diagram*, Hygd extracts it as a screenshot and shows it right inside the event popup
- **Calendar view** — month, week, day, and agenda views via FullCalendar
- **Click any event** to see its full setup details and layout diagram in a modal popup
- **Color-coded** — each unique event name gets a consistent colour across all its rooms

### Supported PDF formats (auto-detected)

| Report | Layout |
|---|---|
| **Daily Resources by Space - All Functions** | space-grouped, fixed-width columns, embedded layout diagrams |
| Daily Resources by Setup Time | date-grouped |
| Services by Function Date | one function per page |

---

## Changelog

### 2026-07-30 — Checkpoint: layout diagrams match the correct event

- **Room-layout diagrams now attach to the right event.** Each embedded *Room Set Diagram* is paired to an event by its **position in the document** — the diagram is attached to the event whose row it chronologically follows (the one sharing that event name and booking number), including diagrams that overflow onto the next page.
- Replaces the previous index-based pairing, which drifted out of sync whenever a room-set event carried no image, or an image had no explicit "Room Set Diagram" line — cascading every following diagram onto the wrong event.
- Verified end-to-end against the full 246-page *Daily Resources by Space* report: all 49 embedded diagrams resolve to the correct room/event.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12 + Flask |
| PDF parsing | pdfplumber (regex state machine — no AI/API needed) |
| Database | SQLite (single file, zero config) |
| Frontend | FullCalendar 6 + Bootstrap 5 |
| Production server | Gunicorn + nginx |

---

## Project structure

```
hygd/
├── app.py              # Flask routes (upload, events API, layouts)
├── parser.py           # PDF text extraction + event parsing (3 formats)
├── database.py         # SQLite read/write helpers
├── requirements.txt    # Python dependencies
├── .env.example        # Template for environment variables
├── templates/
│   └── index.html      # Single-page frontend
├── static/
│   ├── style.css       # Brand styling (Hygd indigo, light + dark)
│   └── app.js          # Calendar, filters, grouped view, event modal
├── uploads/            # Uploaded PDFs (auto-created)
│   └── layouts/        # Extracted room-layout diagram PNGs (auto-created)
└── events.db           # SQLite database (auto-created on first run)
```

---

## Run it locally (Windows)

You only need **Python 3.10+**. All commands are run from the project folder
(`C:\Users\muban\PycharmProjects\amanda`).

### 1. First time only — create the virtual environment

This repo already ships with a `.venv`, so you can usually skip straight to
step 2. If you ever need to rebuild it:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> If PowerShell blocks the activate script, either run it once as
> `powershell -ExecutionPolicy Bypass` or just skip activation and call the
> venv's Python directly (see step 2).

### 2. Start the app

**Option A — activate the venv, then run:**

```powershell
.venv\Scripts\Activate.ps1
python app.py
```

**Option B — no activation needed (one-liner):**

```powershell
.venv\Scripts\python.exe app.py
```

You'll see `Running on http://127.0.0.1:5000`. Open that address in your browser:

```
http://localhost:5000
```

### 3. Load some events

1. Click **Upload PDF** (top-right) and drop in a MECS daily resource report
   (e.g. *Daily Resources by Space - All Functions*).
2. The day agenda fills in. Use the **Department** chips and **Room** dropdown to
   filter, **Grouped** to view by client booking, or click any event for full
   detail and its room-layout screenshot.

### 4. Stop the app

Press **Ctrl + C** in the terminal. That releases port 5000.

> **Port 5000 already in use?** Another copy is still running. Free it with:
> ```powershell
> Get-NetTCPConnection -LocalPort 5000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
> ```
> …or change the port at the bottom of `app.py` (`app.run(..., port=5000)`).

### Notes

- **`debug=True`** is on in `app.py`, so the server auto-reloads when you edit a
  `.py` file. Editing `.html` / `.css` / `.js` only needs a browser refresh.
- Uploading a PDF **adds** to what's already there. Use **Clear** in the app to
  wipe a date range (or everything) first. To reset completely, stop the app and
  delete `events.db` and the `uploads/layouts/` folder.

---

## Deploying to a Linux server (optional)

### 1. Install system dependencies

Tested on **Ubuntu 24.04 / 26.04 LTS**.

```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-full nginx
```

> **Ubuntu note (PEP 668):** modern Ubuntu marks the system Python as
> "externally managed", so a bare `pip install` fails with an
> `externally-managed-environment` error. Always install inside the virtual
> environment created in step 3 — never system-wide. (nginx is only needed if you
> want port 80; skip it for a quick `:5000` run.)

### 2. Copy the project to the server

Run this from your **Windows machine** (Git Bash or WSL). Note the `.venv`
exclusion — the Windows virtual environment won't run on Linux; you'll create a
fresh one on the server in the next step.

```bash
rsync -av \
  --exclude '.venv' --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'uploads/' --exclude 'events.db' --exclude '.idea' \
  /c/Users/muban/PycharmProjects/amanda/ \
  youruser@your-server-ip:/opt/hygd/
```

> Replace `youruser` and `your-server-ip` with your actual Linux username and
> server's LAN IP address. No `rsync`? Use `scp -r` or a `git clone` instead.

### 3. Create a Python virtual environment

```bash
cd /opt/hygd
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Test it manually

```bash
cd /opt/hygd
source .venv/bin/activate
python app.py
```

Open `http://your-server-ip:5000` in a browser. If the calendar loads, press `Ctrl+C` and continue to the next step.

> **Port 5000 already in use?** (Common on a shared server.) Either pick another
> port — `PORT=8000 python app.py`, or with Gunicorn:
> `gunicorn -w 2 -b 0.0.0.0:8000 app:app` — or find what's using it with
> `sudo ss -ltnp | grep :5000`. If you change the port, use the same one in the
> systemd `ExecStart` and the nginx `proxy_pass` below, and open it in `ufw`.

### 5. Create a systemd service (auto-start on boot)

```bash
sudo nano /etc/systemd/system/hygd.service
```

Paste the following — replacing `youruser` with your Linux username:

```ini
[Unit]
Description=Hygd Event Schedule
After=network.target

[Service]
User=youruser
WorkingDirectory=/opt/hygd
ExecStart=/opt/hygd/.venv/bin/gunicorn -w 2 -b 0.0.0.0:5000 app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable hygd
sudo systemctl start hygd
sudo systemctl status hygd
```

You should see `Active: active (running)`.

### 6. Set up nginx (access on port 80)

This step lets you reach the app at `http://your-server-ip` instead of `http://your-server-ip:5000`.

```bash
sudo nano /etc/nginx/sites-available/hygd
```

Paste:

```nginx
server {
    listen 80;
    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
```

Enable the site and restart nginx:

```bash
sudo ln -s /etc/nginx/sites-available/hygd /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

The app is now live at `http://your-server-ip`.

### 7. Reach it from your phone / other devices on the LAN

1. **Find the server's LAN IP:**

   ```bash
   hostname -I
   ```

   Use the `192.168.x.x` (or `10.x.x.x`) address — e.g. `192.168.1.50`.

2. **Open the firewall** for the port you're using:

   ```bash
   sudo ufw allow 80/tcp      # if you set up nginx (step 6)
   sudo ufw allow 5000/tcp    # if you're running the app directly (no nginx)
   ```

3. **On your phone** (connected to the same Wi-Fi/LAN), open:

   - With nginx:      `http://192.168.1.50`
   - Without nginx:   `http://192.168.1.50:5000`

> The app binds to `0.0.0.0`, so it already accepts connections from other
> devices — you only need the correct IP and an open firewall port. This is
> LAN-only; nothing is exposed to the public internet.

---

## Daily use

1. Open the app in your browser
2. Click **Upload PDF** in the top-right corner
3. Drop in the latest MECS daily resource PDF
4. Events appear on the calendar instantly — click any one for full setup details

> Uploading a new PDF **adds** to existing events. Use the **Clear** button first if you want to replace the calendar entirely with the new file.

---

## Updating the app

When you make changes to the code on your Windows machine, push them to the server with rsync and restart the service.

**From your Windows machine:**

```bash
rsync -av --exclude '__pycache__' --exclude '*.pyc' --exclude 'uploads/' --exclude 'events.db' \
  /c/Users/muban/PycharmProjects/amanda/ \
  youruser@your-server-ip:/opt/hygd/
```

**Then on the server (or in the same command):**

```bash
ssh youruser@your-server-ip "sudo systemctl restart hygd"
```

Or as a single one-liner from Windows:

```bash
rsync -av --exclude '__pycache__' --exclude '*.pyc' --exclude 'uploads/' --exclude 'events.db' \
  /c/Users/muban/PycharmProjects/amanda/ \
  youruser@your-server-ip:/opt/hygd/ \
  && ssh youruser@your-server-ip "sudo systemctl restart hygd"
```

> `events.db` and `uploads/` are excluded from rsync so your calendar data is never overwritten during an update.

---

## Useful server commands

```bash
# Check if the service is running
sudo systemctl status hygd

# Start / stop / restart
sudo systemctl start hygd
sudo systemctl stop hygd
sudo systemctl restart hygd

# Watch live logs (useful for debugging)
sudo journalctl -u hygd -f

# If you update requirements.txt (new Python packages)
cd /opt/hygd
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart hygd
```

---

## Troubleshooting

**Calendar loads but shows no events after upload**
- Check the server logs: `sudo journalctl -u hygd -f`
- The PDF must be a supported MECS daily resource report (see the formats table above)

**502 Bad Gateway in browser**
- The Flask app is not running. Check: `sudo systemctl status hygd`
- Restart it: `sudo systemctl restart hygd`

**Upload times out**
- Large PDFs can take a few seconds to parse. The nginx config sets a 120-second timeout which should be plenty.
- If it's still timing out, check available disk space: `df -h`

**Service won't start**
- Run manually to see the error: `cd /opt/hygd && source .venv/bin/activate && python app.py`
- Check that the path in the `.service` file matches where the project is installed

**Port 5000 already in use**
- Another process is on that port. Change the port in the `.service` file (`-b 0.0.0.0:5001`) and update the nginx `proxy_pass` to match.
