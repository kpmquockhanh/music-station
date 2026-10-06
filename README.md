# Music Station

Open one link, add songs to one shared queue, and everyone hears the same song at the same moment. The server downloads audio from YouTube with yt-dlp, and each browser keeps its player aligned with the server clock.

## What you need

- A Mac with Docker Desktop or OrbStack.
- A Tailscale account. The free plan is enough.

## One-time Tailscale setup

1. In the Tailscale admin console, open **DNS** and turn on **MagicDNS** and **HTTPS Certificates**.
2. Open **Access controls** and allow Funnel by adding this entry to the policy file. If the file already has `nodeAttrs`, add the entry to that list.
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
3. Open **Settings → Keys** and generate an auth key. If your tailnet requires device approval, tick **Pre-approved**.

## Start the station

```bash
cp .env.example .env    # then paste the auth key after TS_AUTHKEY=
docker compose up -d --build
docker compose exec tailscale tailscale funnel status
```

The last command prints the public link, `https://music-station.<your-tailnet>.ts.net`. Send it to your friends. The first visit can take up to a minute while Tailscale gets a certificate.

On the Mac you can also use `http://localhost:3000`, and devices on your Wi-Fi can use `http://<mac-ip>:3000`.

The auth key is only used for the first login. The login is then kept in `data/tailscale`, so it does not matter if the key expires later.

If the link says `music-station-1`, an old device named `music-station` still exists. Remove it in the admin console, then run `docker compose restart tailscale`.

### Keep the Mac awake

Docker does not stop the Mac from sleeping. While the station is on, run this in a terminal and leave it open:

```bash
caffeinate -s
```

This only works while the Mac is plugged in, and closing the lid still puts it to sleep.

### Everyday commands

| Task | Command |
|---|---|
| Follow the app log | `docker compose logs -f app` |
| Stop | `docker compose down` |
| Rebuild after changing the code | `docker compose up -d --build` |
| Check yt-dlp against YouTube | `docker compose exec app node apps/server/dist/smoke.js "metronome 120 bpm"` |

yt-dlp updates itself when the app starts and every 24 hours. `docker compose restart app` forces an update.

## Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `TS_AUTHKEY` | required | Tailscale auth key |
| `CACHE_MAX_GB` | `2` | Soft cap for downloaded audio. The oldest songs that are not playing or queued are deleted first. |
| `MAX_DURATION_MIN` | `60` | Longer videos are rejected |
| `YTDLP_COOKIES` | unset | Path inside the container to a cookies file. See below. |

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

## Known limits

- **Tap to resume audio** appears when the browser blocks autoplay or the phone pauses the audio (a call, Siri, AirPods). Tap it to rejoin at the shared position.
- A locked iPhone may not start the next song by itself. Unlock it, and tap the banner if it appears.
- yt-dlp breaks when YouTube changes something. The daily update usually brings a fix within a day or two.
