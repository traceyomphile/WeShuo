from contextlib import asynccontextmanager
from pathlib import Path
import re
import secrets

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .database import database, initialise_database, utc_now, write_lock
from .models import Credentials, DirectMessageCreate, GroupCreate, GroupMessageCreate, MemberCreate
from .connection_manager import manager
from .security import (
    USERNAME_PATTERN, create_token, decode_token, get_current_user,
    hash_password, validate_password, verify_password,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialise_database()
    settings.media_directory.mkdir(parents=True, exist_ok=True)
    if settings.secret_key == "change-me-in-production":
        print("WARNING: Set WESHUO_SECRET_KEY before deploying.")
    yield


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def user_by_username(connection, username: str):
    return connection.execute(
        "SELECT id, username, created_at, last_seen FROM users WHERE username=?", (username,)
    ).fetchone()


def message_dict(row) -> dict:
    return {
        "id": row["id"], "sender": row["sender"], "recipient": row["recipient"],
        "group_id": row["group_id"], "content": row["content"],
        "media_id": row["media_id"], "is_system": bool(row["is_system"]),
        "created_at": row["created_at"],
    }


MESSAGE_SELECT = """
SELECT m.id, sender.username AS sender, recipient.username AS recipient,
       m.group_id, m.content, m.media_id, m.is_system, m.created_at
FROM messages m
JOIN users sender ON sender.id=m.sender_id
LEFT JOIN users recipient ON recipient.id=m.recipient_id
"""


def require_group_member(connection, group_id: int, user_id: int):
    group = connection.execute(
        """SELECT g.id, g.name, g.creator_id, g.created_at
           FROM groups g JOIN group_members gm ON gm.group_id=g.id
           WHERE g.id=? AND gm.user_id=?""", (group_id, user_id)
    ).fetchone()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found or you are not a member")
    return group


def validate_message(content: str, media_id: int | None) -> None:
    if not content and media_id is None:
        raise HTTPException(status_code=422, detail="Message needs text or a media_id")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/register", status_code=201)
def register(body: Credentials):
    username = body.username.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(status_code=422, detail="Username may contain letters, numbers, _, . and -")
    try:
        validate_password(body.password)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    with write_lock, database() as connection:
        if user_by_username(connection, username):
            raise HTTPException(status_code=409, detail="Username already exists")
        cursor = connection.execute(
            "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
            (username, hash_password(body.password), utc_now()),
        )
        connection.commit()
        user_id = cursor.lastrowid
    return {"access_token": create_token(user_id, username), "token_type": "bearer", "user": {"id": user_id, "username": username}}


@app.post("/api/auth/login")
def login(body: Credentials):
    with database() as connection:
        row = connection.execute(
            "SELECT id,username,password_hash FROM users WHERE username=?", (body.username.strip(),)
        ).fetchone()
    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {"access_token": create_token(row["id"], row["username"]), "token_type": "bearer", "user": {"id": row["id"], "username": row["username"]}}


@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return user


@app.get("/api/users")
def users(search: str = Query("", max_length=50), user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            "SELECT id,username,last_seen FROM users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 100",
            (user["id"], f"%{search}%"),
        ).fetchall()
    return [{**dict(row), "online": manager.is_online(row["id"])} for row in rows]


@app.get("/api/messages/direct/{username}")
def direct_history(username: str, after_id: int = 0, limit: int = Query(100, ge=1, le=500), user=Depends(get_current_user)):
    with database() as connection:
        peer = user_by_username(connection, username)
        if peer is None:
            raise HTTPException(status_code=404, detail="User not found")
        rows = connection.execute(
            MESSAGE_SELECT + """ WHERE m.id>? AND m.group_id IS NULL AND
            ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))
            ORDER BY m.id ASC LIMIT ?""",
            (after_id, user["id"], peer["id"], peer["id"], user["id"], limit),
        ).fetchall()
    return [message_dict(row) for row in rows]


@app.post("/api/messages/direct", status_code=201)
async def send_direct(body: DirectMessageCreate, user=Depends(get_current_user)):
    validate_message(body.content, body.media_id)
    with write_lock, database() as connection:
        recipient = user_by_username(connection, body.recipient)
        if recipient is None:
            raise HTTPException(status_code=404, detail="Recipient not found")
        if body.media_id is not None and connection.execute("SELECT 1 FROM media WHERE id=? AND uploader_id=?", (body.media_id, user["id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="Uploaded media not found")
        cursor = connection.execute(
            "INSERT INTO messages(sender_id,recipient_id,content,media_id,created_at) VALUES(?,?,?,?,?)",
            (user["id"], recipient["id"], body.content, body.media_id, utc_now()),
        )
        connection.commit()
        row = connection.execute(MESSAGE_SELECT + " WHERE m.id=?", (cursor.lastrowid,)).fetchone()
    message = message_dict(row)
    await manager.send(recipient["id"], {"type": "message", "data": message})
    return message


@app.get("/api/groups")
def list_groups(user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            """SELECT g.id,g.name,g.creator_id,g.created_at,COUNT(all_members.user_id) member_count
               FROM groups g JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=?
               JOIN group_members all_members ON all_members.group_id=g.id
               GROUP BY g.id ORDER BY g.name""", (user["id"],)
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/groups", status_code=201)
def create_group(body: GroupCreate, user=Depends(get_current_user)):
    name = body.name.strip()
    with write_lock, database() as connection:
        if connection.execute("SELECT 1 FROM groups WHERE name=?", (name,)).fetchone():
            raise HTTPException(status_code=409, detail="Group name already exists")
        member_ids = {user["id"]}
        for username in body.members:
            member = user_by_username(connection, username)
            if member is None:
                raise HTTPException(status_code=404, detail=f"User '{username}' not found")
            member_ids.add(member["id"])
        cursor = connection.execute(
            "INSERT INTO groups(name,creator_id,created_at) VALUES(?,?,?)", (name, user["id"], utc_now())
        )
        group_id = cursor.lastrowid
        connection.executemany(
            "INSERT INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)",
            [(group_id, member_id, utc_now()) for member_id in member_ids],
        )
        connection.commit()
    return {"id": group_id, "name": name, "creator_id": user["id"], "members": len(member_ids)}


@app.get("/api/groups/{group_id}/messages")
def group_history(group_id: int, after_id: int = 0, limit: int = Query(100, ge=1, le=500), user=Depends(get_current_user)):
    with database() as connection:
        require_group_member(connection, group_id, user["id"])
        rows = connection.execute(
            MESSAGE_SELECT + " WHERE m.group_id=? AND m.id>? ORDER BY m.id ASC LIMIT ?",
            (group_id, after_id, limit),
        ).fetchall()
    return [message_dict(row) for row in rows]


@app.post("/api/groups/{group_id}/messages", status_code=201)
async def send_group(group_id: int, body: GroupMessageCreate, user=Depends(get_current_user)):
    validate_message(body.content, body.media_id)
    with write_lock, database() as connection:
        require_group_member(connection, group_id, user["id"])
        if body.media_id is not None and connection.execute("SELECT 1 FROM media WHERE id=? AND uploader_id=?", (body.media_id, user["id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="Uploaded media not found")
        cursor = connection.execute(
            "INSERT INTO messages(sender_id,group_id,content,media_id,created_at) VALUES(?,?,?,?,?)",
            (user["id"], group_id, body.content, body.media_id, utc_now()),
        )
        connection.commit()
        row = connection.execute(MESSAGE_SELECT + " WHERE m.id=?", (cursor.lastrowid,)).fetchone()
        members = [r[0] for r in connection.execute("SELECT user_id FROM group_members WHERE group_id=? AND user_id != ?", (group_id, user["id"])).fetchall()]
    message = message_dict(row)
    for member_id in members:
        await manager.send(member_id, {"type": "message", "data": message})
    return message


@app.post("/api/groups/{group_id}/members", status_code=201)
def add_member(group_id: int, body: MemberCreate, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        if group["creator_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the group creator can add members")
        member = user_by_username(connection, body.username)
        if member is None:
            raise HTTPException(status_code=404, detail="User not found")
        connection.execute(
            "INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)",
            (group_id, member["id"], utc_now()),
        )
        connection.commit()
    return {"group_id": group_id, "username": member["username"]}


@app.delete("/api/groups/{group_id}/members/me", status_code=204)
def leave_group(group_id: int, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        if group["creator_id"] == user["id"]:
            raise HTTPException(status_code=409, detail="The creator cannot leave; delete or transfer the group")
        connection.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (group_id, user["id"]))
        connection.commit()


@app.post("/api/media", status_code=201)
async def upload_media(file: UploadFile = File(...), user=Depends(get_current_user)):
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File is too large")
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(file.filename or "file").name)
    stored_name = f"{secrets.token_hex(16)}_{safe_name}"
    destination = settings.media_directory / stored_name
    destination.write_bytes(data)
    with write_lock, database() as connection:
        cursor = connection.execute(
            "INSERT INTO media(uploader_id,filename,stored_name,content_type,size,created_at) VALUES(?,?,?,?,?,?)",
            (user["id"], safe_name, stored_name, file.content_type or "application/octet-stream", len(data), utc_now()),
        )
        connection.commit()
    return {"id": cursor.lastrowid, "filename": safe_name, "content_type": file.content_type, "size": len(data)}


@app.get("/api/media/{media_id}")
def download_media(media_id: int, user=Depends(get_current_user)):
    with database() as connection:
        row = connection.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Media not found")
        allowed = row["uploader_id"] == user["id"] or connection.execute(
            """SELECT 1 FROM messages m LEFT JOIN group_members gm ON gm.group_id=m.group_id
               WHERE m.media_id=? AND (m.recipient_id=? OR m.sender_id=? OR gm.user_id=?) LIMIT 1""",
            (media_id, user["id"], user["id"], user["id"]),
        ).fetchone()
    if not allowed:
        raise HTTPException(status_code=403, detail="You do not have access to this file")
    return FileResponse(settings.media_directory / row["stored_name"], media_type=row["content_type"], filename=row["filename"])


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token)
    except HTTPException:
        await websocket.close(code=4401)
        return
    user_id = int(payload["sub"])
    await manager.connect(user_id, websocket)
    try:
        await manager.send(user_id, {"type": "connected", "data": {"username": payload["username"]}})
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif event_type in {"call_offer", "call_answer", "ice_candidate", "call_reject", "call_end"}:
                target = event.get("target")
                with database() as connection:
                    recipient = user_by_username(connection, str(target))
                if recipient is None:
                    await websocket.send_json({"type": "error", "detail": "Call target not found"})
                else:
                    await manager.send(recipient["id"], {"type": event_type, "from": payload["username"], "data": event.get("data")})
            else:
                await websocket.send_json({"type": "error", "detail": "Unknown event type"})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(user_id, websocket)
        if not manager.is_online(user_id):
            with write_lock, database() as connection:
                connection.execute("UPDATE users SET last_seen=? WHERE id=?", (utc_now(), user_id))
                connection.commit()
