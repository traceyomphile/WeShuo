from contextlib import contextmanager
from datetime import datetime, timezone
import sqlite3
import threading

from .config import settings


write_lock = threading.RLock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.database_path, timeout=15, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


@contextmanager
def database():
    connection = connect()
    try:
        yield connection
    finally:
        connection.close()


def initialise_database() -> None:
    schema = """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        date_of_birth TEXT,
        profile_media_id INTEGER REFERENCES media(id),
        time_format TEXT NOT NULL DEFAULT '12',
        created_at TEXT NOT NULL,
        last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        creator_id INTEGER NOT NULL REFERENCES users(id),
        profile_media_id INTEGER REFERENCES media(id),
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        is_active INTEGER NOT NULL DEFAULT 1,
        left_at TEXT,
        PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS connections (
        user_one_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_two_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL,
        responded_at TEXT,
        PRIMARY KEY (user_one_id, user_two_id),
        CHECK (user_one_id < user_two_id),
        CHECK (requested_by_id IN (user_one_id, user_two_id))
    );
    CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uploader_id INTEGER NOT NULL REFERENCES users(id),
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        recipient_id INTEGER REFERENCES users(id),
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        media_id INTEGER REFERENCES media(id),
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        CHECK ((recipient_id IS NOT NULL) != (group_id IS NOT NULL)),
        CHECK (length(content) > 0 OR media_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_dm
        ON messages(sender_id, recipient_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_group
        ON messages(group_id, id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user
        ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_connections_requested
        ON connections(requested_by_id, status);
    """
    with write_lock, database() as connection:
        connection.executescript(schema)
        message_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(messages)").fetchall()
        }
        if "delivered_at" not in message_columns:
            connection.execute("ALTER TABLE messages ADD COLUMN delivered_at TEXT")
        if "seen_at" not in message_columns:
            connection.execute("ALTER TABLE messages ADD COLUMN seen_at TEXT")
        user_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(users)").fetchall()
        }
        if "date_of_birth" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN date_of_birth TEXT")
        if "profile_media_id" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN profile_media_id INTEGER REFERENCES media(id)")
        if "time_format" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN time_format TEXT NOT NULL DEFAULT '12'")
        group_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(groups)").fetchall()
        }
        if "description" not in group_columns:
            connection.execute("ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT ''")
        if "profile_media_id" not in group_columns:
            connection.execute("ALTER TABLE groups ADD COLUMN profile_media_id INTEGER REFERENCES media(id)")
        member_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(group_members)").fetchall()
        }
        if "role" not in member_columns:
            connection.execute("ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
        if "is_active" not in member_columns:
            connection.execute("ALTER TABLE group_members ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
        if "left_at" not in member_columns:
            connection.execute("ALTER TABLE group_members ADD COLUMN left_at TEXT")
        connection.execute(
            """UPDATE group_members SET role='admin'
               WHERE EXISTS (
                 SELECT 1 FROM groups g
                 WHERE g.id=group_members.group_id AND g.creator_id=group_members.user_id
               )"""
        )
        # Preserve access to direct chats created before connection requests
        # existed by treating those pairs as already accepted.
        connection.execute(
            """INSERT OR IGNORE INTO connections(
                   user_one_id,user_two_id,requested_by_id,status,created_at,responded_at
               )
               SELECT MIN(sender_id,recipient_id), MAX(sender_id,recipient_id),
                      MIN(sender_id,recipient_id), 'accepted', MIN(created_at), MIN(created_at)
               FROM messages
               WHERE group_id IS NULL
               GROUP BY MIN(sender_id,recipient_id), MAX(sender_id,recipient_id)"""
        )
        connection.commit()
