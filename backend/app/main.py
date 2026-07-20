from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
import re
import secrets

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .database import database, initialise_database, utc_now, write_lock
from .models import AccountDelete, AccountUpdate, AdminUpdate, ConnectionCreate, ConnectionDecision, Credentials, DirectMessageCreate, GroupCreate, GroupMessageCreate, GroupUpdate, MemberCreate, PasswordUpdate
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
        "delivery_status": (
            "seen" if row["seen_at"] else "delivered" if row["delivered_at"] else "sent"
        ),
    }


MESSAGE_SELECT = """
SELECT m.id, sender.username AS sender, recipient.username AS recipient,
       m.group_id, m.content, m.media_id, m.is_system, m.created_at,
       m.delivered_at, m.seen_at
FROM messages m
JOIN users sender ON sender.id=m.sender_id
LEFT JOIN users recipient ON recipient.id=m.recipient_id
"""


def require_group_member(connection, group_id: int, user_id: int):
    group = connection.execute(
        """SELECT g.id, g.name, g.description, g.creator_id, g.profile_media_id, g.created_at,
                  gm.role AS member_role
           FROM groups g JOIN group_members gm ON gm.group_id=g.id
           WHERE g.id=? AND gm.user_id=? AND gm.is_active=1""", (group_id, user_id)
    ).fetchone()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found or you are not a member")
    return group


def require_group_admin(connection, group_id: int, user_id: int):
    group = require_group_member(connection, group_id, user_id)
    if group["member_role"] != "admin":
        raise HTTPException(status_code=403, detail="Only group admins can do that")
    return group


def validate_message(content: str, media_id: int | None) -> None:
    if not content and media_id is None:
        raise HTTPException(status_code=422, detail="Message needs text or a media_id")


def connection_pair(first_id: int, second_id: int) -> tuple[int, int]:
    return (first_id, second_id) if first_id < second_id else (second_id, first_id)


def require_direct_connection(connection, first_id: int, second_id: int) -> None:
    user_one_id, user_two_id = connection_pair(first_id, second_id)
    connected = connection.execute(
        """SELECT 1 FROM connections
           WHERE user_one_id=? AND user_two_id=? AND status='accepted'""",
        (user_one_id, user_two_id),
    ).fetchone()
    if connected is None:
        raise HTTPException(
            status_code=403,
            detail="A connect request must be accepted before you can communicate with this user",
        )


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
    return {"access_token": create_token(user_id, username), "token_type": "bearer", "user": {"id": user_id, "username": username, "date_of_birth": None, "profile_media_id": None, "time_format": "12"}}


@app.post("/api/auth/login")
def login(body: Credentials):
    with database() as connection:
        row = connection.execute(
            """SELECT id,username,password_hash,date_of_birth,profile_media_id,time_format,created_at,last_seen
               FROM users WHERE username=?""", (body.username.strip(),)
        ).fetchone()
    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    login_user = {key: row[key] for key in row.keys() if key != "password_hash"}
    return {"access_token": create_token(row["id"], row["username"]), "token_type": "bearer", "user": login_user}


@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return user


@app.patch("/api/users/me")
def update_account(body: AccountUpdate, user=Depends(get_current_user)):
    fields = body.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="No account changes were supplied")
    with write_lock, database() as connection:
        account = connection.execute(
            "SELECT password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        updates = []
        values = []
        if "username" in fields:
            username = (body.username or "").strip()
            if not USERNAME_PATTERN.fullmatch(username):
                raise HTTPException(status_code=422, detail="Username may contain letters, numbers, _, . and -")
            if username != user["username"]:
                if not body.current_password or not verify_password(body.current_password, account["password_hash"]):
                    raise HTTPException(status_code=403, detail="Current password is required to change your username")
                if connection.execute(
                    "SELECT 1 FROM users WHERE username=? AND id != ?", (username, user["id"])
                ).fetchone():
                    raise HTTPException(status_code=409, detail="Username already exists")
                updates.append("username=?")
                values.append(username)
        if "date_of_birth" in fields:
            if body.date_of_birth and body.date_of_birth > date.today():
                raise HTTPException(status_code=422, detail="Date of birth cannot be in the future")
            updates.append("date_of_birth=?")
            values.append(body.date_of_birth.isoformat() if body.date_of_birth else None)
        if "time_format" in fields:
            if body.time_format is None:
                raise HTTPException(status_code=422, detail="Time format must be 12 or 24")
            updates.append("time_format=?")
            values.append(body.time_format)
        if "profile_media_id" in fields:
            if body.profile_media_id is not None:
                media = connection.execute(
                    "SELECT content_type FROM media WHERE id=? AND uploader_id=?",
                    (body.profile_media_id, user["id"]),
                ).fetchone()
                if media is None:
                    raise HTTPException(status_code=404, detail="Uploaded profile picture not found")
                if not media["content_type"].startswith("image/"):
                    raise HTTPException(status_code=422, detail="Profile picture must be an image")
            updates.append("profile_media_id=?")
            values.append(body.profile_media_id)
        if updates:
            connection.execute(
                f"UPDATE users SET {', '.join(updates)} WHERE id=?", (*values, user["id"])
            )
            connection.commit()
        updated = dict(connection.execute(
            """SELECT id,username,date_of_birth,profile_media_id,time_format,created_at,last_seen
               FROM users WHERE id=?""", (user["id"],)
        ).fetchone())
    token = create_token(updated["id"], updated["username"])
    return {"access_token": token, "token_type": "bearer", "user": updated}


@app.post("/api/users/me/password", status_code=204)
def change_password(body: PasswordUpdate, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        account = connection.execute(
            "SELECT password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if not verify_password(body.current_password, account["password_hash"]):
            raise HTTPException(status_code=403, detail="Current password is incorrect")
        try:
            validate_password(body.new_password)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
        connection.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (hash_password(body.new_password), user["id"]),
        )
        connection.commit()


@app.delete("/api/users/me", status_code=204)
async def delete_account(body: AccountDelete, user=Depends(get_current_user)):
    stored_names: list[str] = []
    with write_lock, database() as connection:
        account = connection.execute(
            "SELECT password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if account is None or not verify_password(body.current_password, account["password_hash"]):
            raise HTTPException(status_code=403, detail="Current password is incorrect")

        owned_media = connection.execute(
            "SELECT id, stored_name FROM media WHERE uploader_id=?", (user["id"],)
        ).fetchall()
        media_ids = [row["id"] for row in owned_media]
        stored_names = [row["stored_name"] for row in owned_media]

        # Keep shared groups alive by promoting the longest-serving active
        # admin/member. A group with no remaining member is removed.
        owned_groups = connection.execute(
            "SELECT id FROM groups WHERE creator_id=?", (user["id"],)
        ).fetchall()
        for group in owned_groups:
            successor = connection.execute(
                """SELECT user_id FROM group_members
                   WHERE group_id=? AND user_id != ? AND is_active=1
                   ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at, user_id
                   LIMIT 1""",
                (group["id"], user["id"]),
            ).fetchone()
            if successor:
                connection.execute(
                    "UPDATE groups SET creator_id=? WHERE id=?",
                    (successor["user_id"], group["id"]),
                )
                connection.execute(
                    "UPDATE group_members SET role='admin' WHERE group_id=? AND user_id=?",
                    (group["id"], successor["user_id"]),
                )
            else:
                connection.execute("DELETE FROM groups WHERE id=?", (group["id"],))

        if media_ids:
            placeholders = ",".join("?" for _ in media_ids)
            connection.execute(
                f"UPDATE users SET profile_media_id=NULL WHERE profile_media_id IN ({placeholders})",
                media_ids,
            )
            connection.execute(
                f"UPDATE groups SET profile_media_id=NULL WHERE profile_media_id IN ({placeholders})",
                media_ids,
            )
            connection.execute(
                f"DELETE FROM messages WHERE media_id IN ({placeholders}) AND length(content)=0",
                media_ids,
            )
            connection.execute(
                f"UPDATE messages SET media_id=NULL WHERE media_id IN ({placeholders})",
                media_ids,
            )

        connection.execute(
            "DELETE FROM messages WHERE sender_id=? OR recipient_id=?",
            (user["id"], user["id"]),
        )
        connection.execute("DELETE FROM media WHERE uploader_id=?", (user["id"],))
        connection.execute("DELETE FROM users WHERE id=?", (user["id"],))
        connection.commit()

    for stored_name in stored_names:
        try:
            (settings.media_directory / stored_name).unlink(missing_ok=True)
        except OSError:
            pass
    await manager.close_user(user["id"], code=1000)


@app.get("/api/connections/requests")
def incoming_connection_requests(user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            """SELECT requester.id, requester.username, requester.profile_media_id,
                      requester.last_seen, c.created_at
               FROM connections c
               JOIN users requester ON requester.id=c.requested_by_id
               WHERE c.status='pending' AND c.requested_by_id != ?
                 AND (c.user_one_id=? OR c.user_two_id=?)
               ORDER BY c.created_at DESC""",
            (user["id"], user["id"], user["id"]),
        ).fetchall()
    return [{**dict(row), "online": manager.is_online(row["id"]), "connection_status": "pending_incoming"} for row in rows]


@app.post("/api/connections/requests", status_code=201)
async def send_connection_request(body: ConnectionCreate, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        recipient = user_by_username(connection, body.username.strip())
        if recipient is None:
            raise HTTPException(status_code=404, detail="User not found")
        if recipient["id"] == user["id"]:
            raise HTTPException(status_code=422, detail="You cannot connect with yourself")
        user_one_id, user_two_id = connection_pair(user["id"], recipient["id"])
        existing = connection.execute(
            "SELECT status,requested_by_id FROM connections WHERE user_one_id=? AND user_two_id=?",
            (user_one_id, user_two_id),
        ).fetchone()
        if existing and existing["status"] == "accepted":
            raise HTTPException(status_code=409, detail="You are already connected")
        if existing and existing["status"] == "pending":
            detail = "This user has already sent you a connect request" if existing["requested_by_id"] != user["id"] else "Connect request already sent"
            raise HTTPException(status_code=409, detail=detail)
        created_at = utc_now()
        connection.execute(
            """INSERT INTO connections(user_one_id,user_two_id,requested_by_id,status,created_at,responded_at)
               VALUES(?,?,?,'pending',?,NULL)
               ON CONFLICT(user_one_id,user_two_id) DO UPDATE SET
                 requested_by_id=excluded.requested_by_id,
                 status='pending',created_at=excluded.created_at,responded_at=NULL""",
            (user_one_id, user_two_id, user["id"], created_at),
        )
        connection.commit()
    payload = {"username": user["username"], "created_at": created_at}
    await manager.send(recipient["id"], {"type": "connection_request", "data": payload})
    return {"username": recipient["username"], "status": "pending_outgoing", "created_at": created_at}


@app.patch("/api/connections/requests/{username}")
async def respond_to_connection_request(username: str, body: ConnectionDecision, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        requester = user_by_username(connection, username)
        if requester is None:
            raise HTTPException(status_code=404, detail="User not found")
        user_one_id, user_two_id = connection_pair(user["id"], requester["id"])
        pending = connection.execute(
            """SELECT 1 FROM connections
               WHERE user_one_id=? AND user_two_id=? AND requested_by_id=? AND status='pending'""",
            (user_one_id, user_two_id, requester["id"]),
        ).fetchone()
        if pending is None:
            raise HTTPException(status_code=404, detail="Pending connect request not found")
        status = "accepted" if body.action == "accept" else "rejected"
        connection.execute(
            """UPDATE connections SET status=?,responded_at=?
               WHERE user_one_id=? AND user_two_id=?""",
            (status, utc_now(), user_one_id, user_two_id),
        )
        connection.commit()
    await manager.send(requester["id"], {
        "type": f"connection_{status}",
        "data": {"username": user["username"]},
    })
    return {"username": requester["username"], "status": status}


@app.get("/api/users")
def users(search: str = Query("", max_length=50), user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            """SELECT u.id,u.username,u.profile_media_id,u.last_seen,
                      CASE
                        WHEN c.status='accepted' THEN 'connected'
                        WHEN c.status='pending' AND c.requested_by_id=? THEN 'pending_outgoing'
                        WHEN c.status='pending' THEN 'pending_incoming'
                        ELSE 'none'
                      END AS connection_status
               FROM users u
               LEFT JOIN connections c ON
                 (c.user_one_id=? AND c.user_two_id=u.id) OR
                 (c.user_two_id=? AND c.user_one_id=u.id)
               WHERE u.id != ? AND u.username LIKE ?
               ORDER BY u.username LIMIT 100""",
            (user["id"], user["id"], user["id"], user["id"], f"%{search}%"),
        ).fetchall()
    return [{**dict(row), "online": manager.is_online(row["id"])} for row in rows]


@app.get("/api/conversations")
def direct_conversations(user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            """SELECT u.id, u.username, u.profile_media_id, u.last_seen,
                      'connected' AS connection_status, MAX(m.id) AS latest_message_id
               FROM users u
               JOIN connections c ON c.status='accepted' AND (
                 (c.user_one_id=? AND c.user_two_id=u.id) OR
                 (c.user_two_id=? AND c.user_one_id=u.id)
               )
               JOIN messages m ON m.group_id IS NULL AND (
                   (m.sender_id=? AND m.recipient_id=u.id) OR
                   (m.recipient_id=? AND m.sender_id=u.id)
               )
               WHERE u.id != ?
               GROUP BY u.id, u.username, u.profile_media_id, u.last_seen
               ORDER BY latest_message_id DESC""",
            (user["id"], user["id"], user["id"], user["id"], user["id"]),
        ).fetchall()
    return [{**dict(row), "online": manager.is_online(row["id"])} for row in rows]


@app.get("/api/messages/direct/{username}")
def direct_history(username: str, after_id: int = 0, limit: int = Query(100, ge=1, le=500), user=Depends(get_current_user)):
    with database() as connection:
        peer = user_by_username(connection, username)
        if peer is None:
            raise HTTPException(status_code=404, detail="User not found")
        require_direct_connection(connection, user["id"], peer["id"])
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
        require_direct_connection(connection, user["id"], recipient["id"])
        if body.media_id is not None and connection.execute("SELECT 1 FROM media WHERE id=? AND uploader_id=?", (body.media_id, user["id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="Uploaded media not found")
        cursor = connection.execute(
            "INSERT INTO messages(sender_id,recipient_id,content,media_id,created_at) VALUES(?,?,?,?,?)",
            (user["id"], recipient["id"], body.content, body.media_id, utc_now()),
        )
        connection.commit()
        row = connection.execute(MESSAGE_SELECT + " WHERE m.id=?", (cursor.lastrowid,)).fetchone()
    message = message_dict(row)
    delivered = await manager.send(recipient["id"], {"type": "message", "data": message})
    if delivered:
        with write_lock, database() as connection:
            connection.execute(
                "UPDATE messages SET delivered_at=COALESCE(delivered_at, ?) WHERE id=?",
                (utc_now(), message["id"]),
            )
            connection.commit()
        message["delivery_status"] = "delivered"
        await manager.send(user["id"], {
            "type": "message_receipt",
            "data": {
                "peer": recipient["username"],
                "up_to_id": message["id"],
                "status": "delivered",
            },
        })
    return message


@app.post("/api/messages/direct/{username}/seen")
async def mark_direct_seen(username: str, user=Depends(get_current_user)):
    seen_at = utc_now()
    with write_lock, database() as connection:
        peer = user_by_username(connection, username)
        if peer is None:
            raise HTTPException(status_code=404, detail="User not found")
        require_direct_connection(connection, user["id"], peer["id"])
        latest = connection.execute(
            """SELECT MAX(id) latest_id FROM messages
               WHERE group_id IS NULL AND sender_id=? AND recipient_id=?""",
            (peer["id"], user["id"]),
        ).fetchone()["latest_id"]
        if latest is not None:
            connection.execute(
                """UPDATE messages
                   SET delivered_at=COALESCE(delivered_at, ?), seen_at=COALESCE(seen_at, ?)
                   WHERE group_id IS NULL AND sender_id=? AND recipient_id=? AND id<=?""",
                (seen_at, seen_at, peer["id"], user["id"], latest),
            )
            connection.commit()
    if latest is not None:
        await manager.send(peer["id"], {
            "type": "message_receipt",
            "data": {
                "peer": user["username"],
                "up_to_id": latest,
                "status": "seen",
            },
        })
    return {"up_to_id": latest, "status": "seen"}


@app.get("/api/groups")
def list_groups(user=Depends(get_current_user)):
    with database() as connection:
        rows = connection.execute(
            """SELECT g.id,g.name,g.description,g.creator_id,g.profile_media_id,g.created_at,
                      mine.role,COUNT(all_members.user_id) member_count
               FROM groups g
               JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=? AND mine.is_active=1
               JOIN group_members all_members ON all_members.group_id=g.id AND all_members.is_active=1
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
            "INSERT INTO group_members(group_id,user_id,joined_at,role) VALUES(?,?,?,?)",
            [(group_id, member_id, utc_now(), "admin" if member_id == user["id"] else "member") for member_id in member_ids],
        )
        connection.commit()
    return {"id": group_id, "name": name, "creator_id": user["id"], "members": len(member_ids)}


@app.patch("/api/groups/{group_id}")
async def update_group(group_id: int, body: GroupUpdate, user=Depends(get_current_user)):
    fields = body.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="No group changes were supplied")
    with write_lock, database() as connection:
        require_group_admin(connection, group_id, user["id"])
        updates = []
        values = []
        if "name" in fields:
            name = (body.name or "").strip()
            if len(name) < 3:
                raise HTTPException(status_code=422, detail="Group name must contain at least 3 characters")
            duplicate = connection.execute(
                "SELECT 1 FROM groups WHERE name=? AND id != ?", (name, group_id)
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=409, detail="Group name already exists")
            updates.append("name=?")
            values.append(name)
        if "description" in fields:
            updates.append("description=?")
            values.append((body.description or "").strip())
        if "profile_media_id" in fields:
            if body.profile_media_id is not None:
                media = connection.execute(
                    "SELECT content_type FROM media WHERE id=? AND uploader_id=?",
                    (body.profile_media_id, user["id"]),
                ).fetchone()
                if media is None:
                    raise HTTPException(status_code=404, detail="Uploaded profile picture not found")
                if not media["content_type"].startswith("image/"):
                    raise HTTPException(status_code=422, detail="Group profile picture must be an image")
            updates.append("profile_media_id=?")
            values.append(body.profile_media_id)
        connection.execute(
            f"UPDATE groups SET {', '.join(updates)} WHERE id=?", (*values, group_id)
        )
        connection.commit()
        row = connection.execute(
            """SELECT g.id,g.name,g.description,g.creator_id,g.profile_media_id,g.created_at,
                      gm.role,COUNT(active.user_id) member_count
               FROM groups g
               JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? AND gm.is_active=1
               JOIN group_members active ON active.group_id=g.id AND active.is_active=1
               WHERE g.id=? GROUP BY g.id""",
            (user["id"], group_id),
        ).fetchone()
        member_ids = [item[0] for item in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchall()]
    result = dict(row)
    event_data = {
        "group_id": group_id,
        "name": result["name"],
        "description": result["description"],
        "profile_media_id": result["profile_media_id"],
    }
    for member_id in member_ids:
        await manager.send(member_id, {"type": "group_updated", "data": event_data})
    return result


@app.get("/api/groups/{group_id}/members")
def group_members(group_id: int, user=Depends(get_current_user)):
    with database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        rows = connection.execute(
            """SELECT u.id, u.username, u.profile_media_id, u.created_at, u.last_seen,
                      gm.role, gm.joined_at, gm.left_at,
                      CASE WHEN gm.is_active=1 THEN 'current' ELSE 'past' END membership_status
               FROM users u JOIN group_members gm ON gm.user_id=u.id
               WHERE gm.group_id=?
               ORDER BY gm.is_active DESC, CASE WHEN u.id=? THEN 0 ELSE 1 END,
                        CASE WHEN gm.role='admin' THEN 0 ELSE 1 END, u.username""",
            (group_id, group["creator_id"]),
        ).fetchall()
    return [{**dict(row), "online": manager.is_online(row["id"])} for row in rows]


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
        members = [r[0] for r in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1 AND user_id != ?",
            (group_id, user["id"]),
        ).fetchall()]
    message = message_dict(row)
    for member_id in members:
        await manager.send(member_id, {"type": "message", "data": message})
    return message


@app.post("/api/groups/{group_id}/members", status_code=201)
async def add_member(group_id: int, body: MemberCreate, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        require_group_admin(connection, group_id, user["id"])
        member = user_by_username(connection, body.username)
        if member is None:
            raise HTTPException(status_code=404, detail="User not found")
        existing = connection.execute(
            "SELECT is_active FROM group_members WHERE group_id=? AND user_id=?",
            (group_id, member["id"]),
        ).fetchone()
        added = existing is None or not existing["is_active"]
        if existing is None:
            connection.execute(
                """INSERT INTO group_members(group_id,user_id,joined_at,role,is_active,left_at)
                   VALUES(?,?,?,'member',1,NULL)""",
                (group_id, member["id"], utc_now()),
            )
        elif not existing["is_active"]:
            connection.execute(
                """UPDATE group_members
                   SET joined_at=?,role='member',is_active=1,left_at=NULL
                   WHERE group_id=? AND user_id=?""",
                (utc_now(), group_id, member["id"]),
            )
        system_message = None
        if added:
            message_cursor = connection.execute(
                """INSERT INTO messages(sender_id,group_id,content,is_system,created_at)
                   VALUES(?,?,?,?,?)""",
                (user["id"], group_id, f'{user["username"]} added {member["username"]}', 1, utc_now()),
            )
        connection.commit()
        if added:
            message_row = connection.execute(
                MESSAGE_SELECT + " WHERE m.id=?", (message_cursor.lastrowid,)
            ).fetchone()
            system_message = message_dict(message_row)
        member_count = connection.execute(
            "SELECT COUNT(*) FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchone()[0]
        member_ids = [row[0] for row in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchall()]
    if added:
        await manager.send(member["id"], {
            "type": "group_added",
            "data": {"group_id": group_id, "member_count": member_count},
        })
        for member_id in member_ids:
            if member_id != member["id"]:
                await manager.send(member_id, {
                    "type": "group_members_changed",
                    "data": {"group_id": group_id, "member_count": member_count},
                })
        for member_id in member_ids:
            await manager.send(member_id, {"type": "message", "data": system_message})
    return {"group_id": group_id, "username": member["username"], "member_count": member_count}


@app.delete("/api/groups/{group_id}/members/me", status_code=204)
async def leave_group(group_id: int, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        if group["creator_id"] == user["id"]:
            raise HTTPException(status_code=409, detail="The creator cannot leave; delete or transfer the group")
        connection.execute(
            """UPDATE group_members SET is_active=0,left_at=?,role='member'
               WHERE group_id=? AND user_id=?""",
            (utc_now(), group_id, user["id"]),
        )
        cursor = connection.execute(
            """INSERT INTO messages(sender_id,group_id,content,is_system,created_at)
               VALUES(?,?,?,?,?)""",
            (user["id"], group_id, f'{user["username"]} left the group', 1, utc_now()),
        )
        connection.commit()
        message = message_dict(connection.execute(
            MESSAGE_SELECT + " WHERE m.id=?", (cursor.lastrowid,)
        ).fetchone())
        remaining_ids = [row[0] for row in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchall()]
        member_count = len(remaining_ids)
    for member_id in remaining_ids:
        await manager.send(member_id, {
            "type": "group_members_changed",
            "data": {"group_id": group_id, "member_count": member_count},
        })
        await manager.send(member_id, {"type": "message", "data": message})


@app.delete("/api/groups/{group_id}/members/{username}")
async def remove_group_member(group_id: int, username: str, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        if group["creator_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the group creator can remove members")
        member = user_by_username(connection, username)
        if member is None:
            raise HTTPException(status_code=404, detail="User not found")
        if member["id"] == group["creator_id"]:
            raise HTTPException(status_code=409, detail="The group creator cannot be removed")
        cursor = connection.execute(
            """UPDATE group_members SET is_active=0,left_at=?,role='member'
               WHERE group_id=? AND user_id=? AND is_active=1""",
            (utc_now(), group_id, member["id"]),
        )
        if not cursor.rowcount:
            raise HTTPException(status_code=404, detail="User is not a group member")
        message_cursor = connection.execute(
            """INSERT INTO messages(sender_id,group_id,content,is_system,created_at)
               VALUES(?,?,?,?,?)""",
            (user["id"], group_id, f'{user["username"]} removed {member["username"]}', 1, utc_now()),
        )
        connection.commit()
        system_message = message_dict(connection.execute(
            MESSAGE_SELECT + " WHERE m.id=?", (message_cursor.lastrowid,)
        ).fetchone())
        member_count = connection.execute(
            "SELECT COUNT(*) FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchone()[0]
        remaining_ids = [row[0] for row in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchall()]
    await manager.send(member["id"], {
        "type": "group_removed",
        "data": {"group_id": group_id},
    })
    for member_id in remaining_ids:
        await manager.send(member_id, {
            "type": "group_members_changed",
            "data": {"group_id": group_id, "member_count": member_count},
        })
        await manager.send(member_id, {"type": "message", "data": system_message})
    return {"group_id": group_id, "username": member["username"], "member_count": member_count}


@app.patch("/api/groups/{group_id}/members/{username}/admin")
async def update_member_admin(group_id: int, username: str, body: AdminUpdate, user=Depends(get_current_user)):
    with write_lock, database() as connection:
        group = require_group_member(connection, group_id, user["id"])
        if group["creator_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the group owner can change admin rights")
        member = user_by_username(connection, username)
        if member is None:
            raise HTTPException(status_code=404, detail="User not found")
        if member["id"] == group["creator_id"]:
            raise HTTPException(status_code=409, detail="The group owner always remains an admin")
        membership = connection.execute(
            """SELECT role FROM group_members
               WHERE group_id=? AND user_id=? AND is_active=1""",
            (group_id, member["id"]),
        ).fetchone()
        if membership is None:
            raise HTTPException(status_code=404, detail="User is not a current group member")
        role = "admin" if body.is_admin else "member"
        changed = membership["role"] != role
        system_message = None
        if changed:
            connection.execute(
                "UPDATE group_members SET role=? WHERE group_id=? AND user_id=?",
                (role, group_id, member["id"]),
            )
            action = "made" if body.is_admin else "removed"
            suffix = "an admin" if body.is_admin else "as an admin"
            cursor = connection.execute(
                """INSERT INTO messages(sender_id,group_id,content,is_system,created_at)
                   VALUES(?,?,?,?,?)""",
                (user["id"], group_id, f'{user["username"]} {action} {member["username"]} {suffix}', 1, utc_now()),
            )
            connection.commit()
            system_message = message_dict(connection.execute(
                MESSAGE_SELECT + " WHERE m.id=?", (cursor.lastrowid,)
            ).fetchone())
        member_ids = [row[0] for row in connection.execute(
            "SELECT user_id FROM group_members WHERE group_id=? AND is_active=1", (group_id,)
        ).fetchall()]
    if changed:
        for member_id in member_ids:
            await manager.send(member_id, {
                "type": "group_members_changed",
                "data": {"group_id": group_id, "member_count": len(member_ids)},
            })
            await manager.send(member_id, {"type": "message", "data": system_message})
    return {"group_id": group_id, "username": member["username"], "role": role}


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
               WHERE m.media_id=? AND (
                 m.recipient_id=? OR m.sender_id=? OR (gm.user_id=? AND gm.is_active=1)
               ) LIMIT 1""",
            (media_id, user["id"], user["id"], user["id"]),
        ).fetchone()
        if not allowed:
            allowed = connection.execute(
                """SELECT 1 FROM groups g
                   JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? AND gm.is_active=1
                   WHERE g.profile_media_id=? LIMIT 1""",
                (user["id"], media_id),
            ).fetchone()
        if not allowed:
            allowed = connection.execute(
                "SELECT 1 FROM users WHERE profile_media_id=? LIMIT 1", (media_id,)
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
        delivered_at = utc_now()
        with write_lock, database() as connection:
            pending = connection.execute(
                """SELECT sender_id, MAX(id) up_to_id FROM messages
                   WHERE group_id IS NULL AND recipient_id=? AND delivered_at IS NULL
                   GROUP BY sender_id""",
                (user_id,),
            ).fetchall()
            connection.execute(
                """UPDATE messages SET delivered_at=?
                   WHERE group_id IS NULL AND recipient_id=? AND delivered_at IS NULL""",
                (delivered_at, user_id),
            )
            connection.commit()
        for receipt in pending:
            await manager.send(receipt["sender_id"], {
                "type": "message_receipt",
                "data": {
                    "peer": payload["username"],
                    "up_to_id": receipt["up_to_id"],
                    "status": "delivered",
                },
            })
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif event_type in {"call_offer", "call_answer", "ice_candidate", "call_reject", "call_end"}:
                target = event.get("target")
                with database() as connection:
                    recipient = user_by_username(connection, str(target))
                    connected = recipient and connection.execute(
                        """SELECT 1 FROM connections WHERE status='accepted' AND (
                             (user_one_id=? AND user_two_id=?) OR
                             (user_one_id=? AND user_two_id=?))""",
                        (user_id, recipient["id"] if recipient else -1, recipient["id"] if recipient else -1, user_id),
                    ).fetchone()
                if recipient is None:
                    await websocket.send_json({"type": "error", "detail": "Call target not found"})
                elif connected is None:
                    await websocket.send_json({"type": "error", "detail": "Connect request must be accepted before calling this user"})
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
