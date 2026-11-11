# Twitch Utils

A userscript that adds a toggleable utility panel to Twitch: audio tools, playback stats, quality control, ad muting, channel points helpers and more.

This is a modified version of [Twitch Utils by SpacersVIP](https://greasyfork.org/en/scripts/587335-twitch-utils), adjusted to work alongside the [TwitchAdSolutions (vaft)](https://github.com/pixeltris/TwitchAdSolutions) script.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the script link and confirm the install: [twitch-utils.user.js](https://raw.githubusercontent.com/nicolaspaillard/Twitch-Utils/main/twitch-utils.user.js)

_The script updates itself._

## Usage

Press the menu key on any Twitch page to open or close the panel. The default key is `²`, and you can change it from the panel's Layout section. The panel can be dragged, and each section can be folded.

## Import settings

A ready-to-import [settings.json](settings.json) is included. Open the Twitch Utils panel, use the import option in the settings menu, and paste the contents of that file.

## Features

**Audio**

- Gain up to 500%
- Compressor ("Leveling") with a live gain-reduction meter
- Bass shelf and mono downmix
- Auto gain: reads Twitch's own per-channel loudness value and sets the gain to reach a target level you choose

**Quality**

- Pin any quality from the player's real quality list
- Pinning turns off automatic quality, so Twitch's dropped-frame and viewport filters no longer lower your quality
- Button that lists which qualities the player is refusing to give you, and why
- Optional drop to the lowest quality while the tab is in the background
- Fit mode for ultrawide screens (stretch or crop) and a saturation slider

**Playback stats**

- FPS, dropped and decoded frames, buffer, resolution, live latency, bitrate and bandwidth estimate
- Optional overlay on the player

**Latency**

- Low-latency toggle
- Latency cap that speeds playback slightly until you catch up

**Ads**

- Mutes and blanks the player during ad breaks
- Shows the remaining time, taken from the player's own ad events

**Channel points**

- Balances for a list of channels in one panel
- Claims pending chests
- Auto-claim while you watch
- List of followed channels that are live

**Lurk**

- Runs real players for several channels in small thumbnails on one page, muted and at the lowest quality, claiming their own chests

**VOD and rewind**

- Frame step with `,` and `.`, A/B loop, copy a timestamped link
- Rewind on live streams that expose a DVR window

**Other**

- Screenshot, picture-in-picture, copy the stream manifest URL (for mpv, VLC, yt-dlp)
- Auto-dismiss content warnings and age gates
- Hide the Prime crown, sidebar or chat
- Export and import settings

## Important

The script must keep `@grant none`. That keeps it in the page context, where Twitch's player is reachable. Any other `@grant` value sandboxes it, and the console will show `video present but player core unreachable`.

## What it does not do

- It does not block ads. It only mutes and blanks them. For ad blocking, use a separate script such as vaft.
- It does not fake watch time. Points need a real running player.
- It cannot cast. Twitch's video uses a `blob:` source that a Chromecast cannot open. Use "Copy stream URL" and cast from VLC instead.
- It cannot rewind past what you have watched. Live rewind only covers the current session.

## Privacy

- The script reads Twitch's `Authorization` header from Twitch's own requests. It keeps it in memory only and uses it only for requests to `gql.twitch.tv`.
- It makes no network requests to anything other than Twitch, and has no telemetry.
- Settings are stored in your browser's localStorage.

## Credits and license

Original script by SpacersVIP ([Greasy Fork](https://greasyfork.org/en/scripts/587335-twitch-utils)). Modifications by [nicolaspaillard](https://github.com/nicolaspaillard).

Released under the [MIT License](LICENSE).
