import os
from functools import lru_cache

from dotenv import load_dotenv
from supabase import create_client, Client
from supabase.lib.client_options import SyncClientOptions

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise RuntimeError(
        "Set SUPABASE_URL and SUPABASE_ANON_KEY (see backend/.env.example)."
    )

BUCKET = "known-faces"


@lru_cache(maxsize=1)
def _shared_anon() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY)


def anon_client() -> Client:
    """Shared client scoped to no user — public check-in inserts and reads.
    Cached so each request doesn't pay client-construction cost."""
    return _shared_anon()


def fresh_anon_client() -> Client:
    """Own instance. Use for sign-in so session state never leaks into the shared client."""
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY)


def client_as(access_token: str | None) -> Client:
    """Client that carries the caller's Supabase JWT on EVERY sub-client
    (Postgrest, Storage, ...), so RLS runs as that user.

    The token is passed through ClientOptions.headers — the supported path.
    Poking `c.storage._client.headers` after construction is version-fragile and
    silently falls back to the anon role, which is what produced
    'new row violates row-level security policy' (403) on enroll."""
    if not access_token:
        return create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    opts = SyncClientOptions(headers={"Authorization": f"Bearer {access_token}"})
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY, options=opts)


def list_bucket(sb: Client) -> list[dict]:
    """All objects in the bucket. Storage list() returns only 100 by default,
    so a roster bigger than that silently lost people."""
    out, offset = [], 0
    while True:
        page = sb.storage.from_(BUCKET).list(
            "", {"limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}}
        )
        out.extend(page)
        if len(page) < 1000:
            return out
        offset += 1000
