# Music Station

Open one link, add songs to one shared queue, and everyone hears the same song at the same moment. The server downloads audio from YouTube with yt-dlp, and each browser keeps its player aligned with the server clock.

## What you need

- A Raspberry Pi 5 (or any Linux box or Mac) with Docker and the Compose plugin.

## Start the station

```bash
cp .env.example .env    # optional, to change the defaults below
docker compose up -d --build
```

Open `http://<pi-ip>:3000` from any device on the same Wi-Fi and share that link. The first build on a Pi takes a few minutes. Anyone on the network can join and control the queue.

## Public access (optional)

A Cloudflare Tunnel gives the station a public https link, such as `https://music.example.com`, without opening a port on your router. You need a domain on Cloudflare; the free plan is enough. The Wi-Fi link keeps working.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels** and create a tunnel of type **Cloudflared**. Name it `music-station`.
2. Copy the token from the install command it shows (the long string after `--token`). You do not need to run that command.
3. Add a public hostname: pick a subdomain such as `music` and your domain, set the service type to **HTTP** and the URL to `app:3000`.
4. In `.env`, set:
   ```
   COMPOSE_PROFILES=tunnel
   TUNNEL_TOKEN=<the token>
   ```
5. Run `docker compose up -d`, then `docker compose logs cloudflared`. Lines saying `Registered tunnel connection` mean it is up.

Anyone with the link can join and control the queue. To limit who can open it, add a Cloudflare Access application for the hostname in **Zero Trust → Access**.

### On a Raspberry Pi

- Raspberry Pi OS runs the Pi 5 with a 16K memory-page kernel, which some arm64 programs do not support. If the app log shows a crash about the page size, add `kernel=kernel8.img` to `/boot/firmware/config.txt` and reboot.
- Downloaded audio goes to `data/app/cache`. An SSD or USB drive lasts longer than an SD card.
- A 1 GB Pi runs the station fine but struggles to build it. `scripts/deploy-pi.sh` builds the arm64 image on your computer, sends it to the Pi over SSH and restarts the containers there. It deploys to `pi@pi-linhng:~/music-station` unless `DEPLOY_HOST` or `DEPLOY_DIR` say otherwise. Add `--env` to also copy your `.env`; the first deploy needs it.

### Everyday commands

| Task | Command |
|---|---|
| Follow the app log | `docker compose logs -f app` |
| Follow the tunnel log | `docker compose logs -f cloudflared` |
| Stop | `docker compose down` |
| Rebuild after changing the code | `docker compose up -d --build` |
| Check yt-dlp against YouTube | `docker compose exec app node apps/server/dist/smoke.js "metronome 120 bpm"` |

yt-dlp updates itself when the app starts and every 24 hours. `docker compose restart app` forces an update.

## Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `COMPOSE_PROFILES` | unset | `tunnel` starts the Cloudflare Tunnel |
| `TUNNEL_TOKEN` | unset | Cloudflare Tunnel token |
| `CACHE_MAX_GB` | `2` | Soft cap for downloaded audio. The oldest songs that are not playing or queued are deleted first. |
| `MAX_DURATION_MIN` | `60` | Longer videos are rejected |
| `YTDLP_COOKIES` | unset | Path inside the container to a cookies file. See below. |
| `SYNC_LOG` | unset | `1` logs each device's sync status every 5 seconds |

The app keeps everything in `data/app`: audio files in `cache/` and the queue in `station.json`. To free space, stop the station and delete `data/app/cache`.

## If YouTube asks "Sign in to confirm you're not a bot"

The app log then shows `YouTube bot check hit`, and songs fail to add. Try these in order:

1. Run `docker compose restart app` to update yt-dlp.
2. Wait an hour. These blocks usually lift on their own.
3. Use cookies from a spare Google account, not your main one, because YouTube can flag an account used this way.
   1. Sign in to YouTube with the spare account in a private browser window.
   2. Export the YouTube cookies in Netscape format with a cookies.txt browser extension. Save the file as `data/app/cookies.txt`.
   3. Close the private window, so the browser does not rotate those cookies.
   4. Set `YTDLP_COOKIES=/data/cookies.txt` in `.env` and run `docker compose up -d`.

## Checking sync

1. Open the station on a laptop and two phones in the same room. Search for "metronome 120 bpm" and add a result.
2. Listen. One clean tick means the devices are in sync. Doubled or smeared ticks mean they are not.
3. Open **Settings** on each device. After a few seconds, **Drift** should stay within about ±30 ms.
4. On a device that plays through a Bluetooth speaker, raise **Speaker delay** until its ticks line up with the others.

If a device shows **Tap to resume audio**, its browser blocked playback or the phone paused it. Tap the button once.

## Desktop app

Music Station also runs as an app on Mac and Windows. It opens the station in its own window, joins with your saved nickname, and keeps playing when you close the window. The menu bar (Mac) or tray (Windows) icon shows the song playing now and has **Pause for everyone**, **Play for everyone** and **Skip for everyone**. On Mac, clicking the menu-bar icon opens a card with the song, a box to search or paste a YouTube link, and Up next.

Download the latest installer from the [Releases page](https://github.com/kpmquockhanh/music-station/releases): `Music-Station-<version>-mac.dmg` or `Music-Station-<version>-windows.exe`. The apps are not signed, so the first launch takes one extra step:

- **Mac:** open the `.dmg` and drag Music Station to Applications. Open it once; macOS refuses. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** run the `.exe`. When SmartScreen warns, click **More info → Run anyway**. It installs for your user only, without admin rights.

The app opens `https://music.devxdev.site`. To use another station, choose **Change station…** in the menu bar or tray menu and type its address, such as `192.168.1.20:3000`.

The keyboard media keys control this computer only. **Pause** stops the sound here while the station keeps playing for everyone else, and **Play** rejoins at the shared position. **Next**, like a headset's next button, skips the song for everyone.

The app's screens update with every server deploy. A new installer is only needed for changes to the app itself.

To publish installers, set `version` in `apps/desktop/package.json` and run `pnpm --filter @music-station/desktop dist` on a Mac for the `.dmg` and on Windows for the `.exe`. The installers land in `apps/desktop/release/`. Attach them to a release on GitHub by hand.

## Development

```bash
brew install yt-dlp deno ffmpeg
pnpm install
pnpm --filter @music-station/server dev    # API on http://localhost:3000, data in apps/server/data
pnpm --filter @music-station/web dev       # UI on http://localhost:5173
```

Run the two `dev` commands in separate terminals and open http://localhost:5173. The Homebrew yt-dlp cannot update itself, so the server logs `yt-dlp update failed` at start. Update it with `brew upgrade yt-dlp` instead.

| Task | Command |
|---|---|
| Unit and integration tests | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Production build | `pnpm build` |
| yt-dlp smoke check | `pnpm build && node apps/server/dist/smoke.js` |
| Desktop app against the local UI | `STATION_URL=http://localhost:5173 pnpm --filter @music-station/desktop dev` |
| Desktop installer (`.dmg` on a Mac) | `pnpm --filter @music-station/desktop dist` |

Without `STATION_URL`, `dev` opens the saved station, which is `https://music.devxdev.site` by default.

## Known limits

- **Tap to resume audio** appears when the browser blocks autoplay or the phone pauses the audio (a call, Siri, AirPods). Tap it to rejoin at the shared position.
- A locked iPhone may not start the next song by itself. Unlock it, and tap the banner if it appears.
- yt-dlp breaks when YouTube changes something. The daily update usually brings a fix within a day or two.
