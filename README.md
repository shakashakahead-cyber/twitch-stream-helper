# Twitch Stream Helper

Chrome extension to manage your Twitch stream title, category, tags, and open an X post.

## Features
- Update stream title and category
- Manage saved tags per category
- Compose an X post with optional category hashtag

## Requirements
- Chrome/Chromium
- Twitch account with permission to manage broadcast settings

## OAuth setup (required)
This extension uses Twitch OAuth via `chrome.identity.launchWebAuthFlow`. You must register your own Twitch application and set the Client ID in `background.js`.

1. Create a Twitch application in the Twitch developer console.
2. Set the OAuth redirect URL to the value returned by `chrome.identity.getRedirectURL()`.
   - For an installed extension, this looks like `https://<EXTENSION_ID>.chromiumapp.org/`.
3. Copy the **Client ID** into `background.js`:

```js
const clientId = "YOUR_TWITCH_CLIENT_ID";
```

4. The required scope is `channel:manage:broadcast`.

Note: This project currently uses the implicit flow (`response_type=token`). For production, consider migrating to the authorization code flow with PKCE.

## Run (unpacked)
1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select this folder.
3. Click the extension icon and log in.

## Configuration notes
- Tokens and preferences are stored in `chrome.storage.local` on your device.
- Do not commit a Twitch Client Secret to this repository.
