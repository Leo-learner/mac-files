# Mac Files

Mac Files is a small protected local web file manager for macOS. It was split out from the AI Chat project as an independent open-source tool.

## Features

- Admin-protected login with JWT authentication.
- File and folder listing inside a configured root.
- Search, text preview, download, upload, rename, delete, copy, and move.
- Path traversal protection keeps all operations inside `FINDER_ROOT`.
- Local SQLite user database.

## Requirements

- macOS
- Node.js 18+
- `zip` or `ditto` for folder downloads

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set:

- `JWT_SECRET` to a strong random value.
- `FINDER_ROOT` to the folder this app may manage.
- `ADMIN_USERNAME` to the username that should become admin on first registration.

## Run

```bash
npm start
```

Open `http://localhost:3302`, create the admin account, then sign in.

## Security Notes

- Keep this app bound to localhost unless you fully understand the risk.
- All file operations are restricted to `FINDER_ROOT`.
- Admin authorization is enforced server-side, not only in the UI.
- Do not point `FINDER_ROOT` at sensitive system directories unless this is strictly for personal admin use.

## Checks

```bash
npm run check
npm run smoke:startup
npm run smoke:auth
```
