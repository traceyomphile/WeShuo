import base64
import hashlib
import hmac
import json
import os
import re
import time

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .database import database


bearer = HTTPBearer(auto_error=False)
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")


def validate_password(password: str) -> None:
    failures = []
    if len(password) < 8:
        failures.append("at least 8 characters")
    if not re.search(r"[A-Z]", password):
        failures.append("an uppercase letter")
    if not re.search(r"[a-z]", password):
        failures.append("a lowercase letter")
    if not re.search(r"\d", password):
        failures.append("a number")
    if not re.search(r"[^A-Za-z0-9]", password):
        failures.append("a special character")
    if failures:
        raise ValueError("Password needs " + ", ".join(failures) + ".")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    iterations = 600_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt_hex, expected_hex = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(actual, bytes.fromhex(expected_hex))
    except (ValueError, TypeError):
        return False


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_token(user_id: int, username: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "exp": int(time.time()) + settings.token_ttl_seconds,
    }
    body = _b64encode(json.dumps(payload, separators=(",", ":")).encode())
    signature = hmac.new(settings.secret_key.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64encode(signature)}"


def decode_token(token: str) -> dict:
    try:
        body, supplied_signature = token.split(".", 1)
        expected = hmac.new(settings.secret_key.encode(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64decode(supplied_signature)):
            raise ValueError
        payload = json.loads(_b64decode(body))
        if int(payload["exp"]) < int(time.time()):
            raise ValueError
        return payload
    except (ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    payload = decode_token(credentials.credentials)
    with database() as connection:
        row = connection.execute(
            """SELECT id,username,date_of_birth,profile_media_id,time_format,created_at,last_seen
               FROM users WHERE id=?""", (payload["sub"],)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return dict(row)
