from pydantic import BaseModel, Field, field_validator


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=30)
    password: str = Field(min_length=8, max_length=128)


class DirectMessageCreate(BaseModel):
    recipient: str = Field(min_length=3, max_length=30)
    content: str = Field(default="", max_length=4000)
    media_id: int | None = None

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        return value.strip()


class GroupCreate(BaseModel):
    name: str = Field(min_length=3, max_length=60)
    members: list[str] = Field(default_factory=list, max_length=100)


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=60)
    description: str | None = Field(default=None, max_length=500)
    profile_media_id: int | None = None


class AdminUpdate(BaseModel):
    is_admin: bool


class GroupMessageCreate(BaseModel):
    content: str = Field(default="", max_length=4000)
    media_id: int | None = None

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        return value.strip()


class MemberCreate(BaseModel):
    username: str
