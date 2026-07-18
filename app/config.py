from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_name: str = "WeShuō Chat API"
    database_path: Path = Path(os.getenv("WESHUŌ_DATABASE_PATH", "data/weshuō.db"))
    media_directory: Path = Path(os.getenv("WESHUŌ_MEDIA_DIRECTORY", "data/media"))
    secret_key: str = os.getenv("WESHUŌ_SECRET_KEY", "change-me-in-production")
    token_ttl_seconds: int = int(os.getenv("WESHUŌ_TOKEN_TTL_SECONDS", "86400"))
    max_upload_bytes: int = int(os.getenv("WESHUŌ_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
    allowed_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv(
            "WESHUŌ_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(",")
        if origin.strip()
    )


settings = Settings()
