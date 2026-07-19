# WeShuō Backend

FastAPI backend adapted from COONECTED Networked Chat Application. It supports signed-token authentication, direct and group messages, persistent SQLite history, media uploads, WebSocket delivery/presence, and WebRTC call signalling.

## Run it

Use Python 3.11 or newer.

```bash
cd backend
python -m venv .venv
```

Activate the environment:

```powershell
# Windows PowerShell
.venv\Scripts\Activate.ps1
```

```bash
# macOS/Linux
source .venv/bin/activate
```

Then install and start:

```bash
pip install -r requirements.txt
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Put the generated value in `WESHUŌ_SECRET_KEY`, then run:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Interactive API documentation: `http://127.0.0.1:8000/docs`

## Frontend connection

1. Register or log in through `/api/auth/*`.
2. Save the returned `access_token` and send it as `Authorization: Bearer <token>`.
3. Connect to `ws://127.0.0.1:8000/ws?token=<token>` for real-time messages and call signalling.
4. Send chat messages through the HTTP endpoints. WebSocket events notify connected recipients.

For a media message, first upload the file to `/api/media`, then use the returned `id` as `media_id` when sending a direct or group message.

## Main routes

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/users`
- `GET /api/messages/direct/{username}`, `POST /api/messages/direct`
- `GET/POST /api/groups`, `GET/POST /api/groups/{id}/messages`
- `POST /api/groups/{id}/members`, `DELETE /api/groups/{id}/members/me`
- `POST /api/media`, `GET /api/media/{id}`
- `WS /ws`

The API docs contain exact request/response schemas.

## Run the tests

```bash
pip install -r requirements-dev.txt
pytest -q
```

## Production notes

- Run behind HTTPS/WSS and never deploy with the default secret.
- SQLite is fine for one server instance. Use PostgreSQL plus Redis when scaling to multiple instances.
- WebRTC needs STUN and usually TURN in production. The WebSocket endpoint only relays signalling data; browser-to-browser media uses WebRTC.
