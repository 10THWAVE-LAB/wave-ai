#!/usr/bin/env python3
"""Deploy WAVE AI to Cloudflare Workers + D1 via the Cloudflare API.

Why this exists: the Cloudflare dashboard sign-up is blocked by Turnstile
in Muse's cloud browser, and the vault-stored API token cannot be passed
to wrangler's environment. So deployment goes through direct API calls,
authenticated with the token stored in Muse's Secure Vault (connection
"custom.cloudflare") via the surrogate pattern from
/opt/muse/skills/custom-connector-setup/.

Prerequisites (one-time, done by the user on their own device):
  1. A free Cloudflare account.
  2. An API token with the "Edit Cloudflare Workers" template (needs
     Workers Scripts:Edit and D1:Edit), saved via Muse's Secure Vault
     as the custom.cloudflare connection.

What it does:
  (a) Finds the Cloudflare account ID.
  (b) Finds (or creates) the D1 database "wave-ai-db" and prints its ID.
  (c) Builds dist/worker.js if missing/stale, then uploads it as the
      "wave-ai" Worker with the D1 binding and env vars.
  (d) Sets the SESSION_SECRET (from ~/workspace/wave-ai-cloudflare-secret.txt)
      and ADMIN_EMAIL secrets. The secret value is NEVER printed or logged.
  (e) Prints the live https://wave-ai.<subdomain>.workers.dev URL and
      checks its /healthz endpoint.

Usage:  python3 scripts/cloudflare_api_deploy.py   (from anywhere)

NOTE: untested against the live API until the token is connected — the
first real run is the proof. On a 401/403, check the token's permissions
in the Cloudflare dashboard (My Profile > API Tokens).
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import (  # noqa: E402
    DynamicCredentialError,
    add_surrogate_to_request,
    read_json_response,
)

API_BASE = "https://api.cloudflare.com/client/v4"
CREDENTIAL_NAME = "custom.cloudflare"
ALLOWED_HOSTS = ["api.cloudflare.com"]
WORKER_NAME = "wave-ai"
DATABASE_NAME = "wave-ai-db"
ADMIN_EMAIL = "pampamindino@gmail.com"

REPO = Path(__file__).resolve().parent.parent
SECRET_FILE = Path.home() / "workspace" / "wave-ai-cloudflare-secret.txt"
DIST_WORKER = REPO / "dist" / "worker.js"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


OPENER = urllib.request.build_opener(NoRedirect())


class ApiError(RuntimeError):
    pass


def cf_request(method: str, path: str, body: bytes | None = None,
               content_type: str | None = None) -> dict:
    """One authenticated Cloudflare API call. Returns the parsed JSON."""
    url = API_BASE + path
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        add_surrogate_to_request(req, CREDENTIAL_NAME, allowed_hosts=ALLOWED_HOSTS)
    except DynamicCredentialError as exc:
        raise ApiError(
            "Could not load the Cloudflare API credential from the vault "
            f"({exc}). Has the custom.cloudflare connection been set up yet?"
        ) from exc
    try:
        with OPENER.open(req, timeout=120) as resp:
            payload = read_json_response(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(detail)
            msgs = "; ".join(
                f"{e.get('code')}: {e.get('message')}" for e in err.get("errors", [])
            ) or detail
        except json.JSONDecodeError:
            msgs = detail
        raise ApiError(f"{method} {path} -> HTTP {exc.code}: {msgs}") from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"{method} {path} -> network error: {exc}") from exc
    if not payload.get("success"):
        msgs = "; ".join(
            f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", [])
        ) or "unknown error"
        raise ApiError(f"{method} {path} -> Cloudflare error: {msgs}")
    return payload


def get_account_id() -> str:
    payload = cf_request("GET", "/accounts")
    accounts = payload.get("result") or []
    if not accounts:
        raise ApiError("No Cloudflare accounts found for this API token.")
    if len(accounts) > 1:
        print(f"Note: {len(accounts)} accounts visible; using the first.")
        for acc in accounts:
            print(f"  - {acc.get('id')} ({acc.get('name')})")
    account = accounts[0]
    print(f"Account: {account.get('name')} ({account.get('id')})")
    return account["id"]


def ensure_d1_database(account_id: str) -> str:
    payload = cf_request("GET", f"/accounts/{account_id}/d1/database")
    for db in payload.get("result") or []:
        if db.get("name") == DATABASE_NAME:
            print(f"D1 database '{DATABASE_NAME}' already exists: {db['uuid']}")
            return db["uuid"]
    print(f"Creating D1 database '{DATABASE_NAME}'...")
    body = json.dumps({"name": DATABASE_NAME}).encode("utf-8")
    payload = cf_request(
        "POST", f"/accounts/{account_id}/d1/database", body, "application/json"
    )
    db_id = payload["result"]["uuid"]
    print(f"Created D1 database '{DATABASE_NAME}': {db_id}")
    return db_id


def build_is_stale() -> bool:
    """True when dist/worker.js is missing or older than any source file."""
    if not DIST_WORKER.exists():
        return True
    bundle_mtime = DIST_WORKER.stat().st_mtime
    newest = 0.0
    for sub in ("src", "public", "scripts"):
        for path in (REPO / sub).rglob("*"):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                continue  # build artifacts, not bundle inputs
            if path.name == "cloudflare_api_deploy.py":
                continue  # the deploy helper itself, not bundle input
            newest = max(newest, path.stat().st_mtime)
    for name in ("package.json", "package-lock.json"):
        p = REPO / name
        if p.exists():
            newest = max(newest, p.stat().st_mtime)
    return newest > bundle_mtime


def ensure_build() -> None:
    if not build_is_stale():
        print(f"Bundle is up to date: {DIST_WORKER}")
        return
    print("Building the Worker bundle (npm run build)...")
    proc = subprocess.run(
        ["npm", "run", "build"], cwd=REPO, capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise ApiError(f"npm run build failed:\n{proc.stdout}\n{proc.stderr}")
    print(proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "build ok")
    print(f"Bundle: {DIST_WORKER} ({DIST_WORKER.stat().st_size} bytes)")


def upload_worker(account_id: str, database_id: str) -> None:
    script = DIST_WORKER.read_bytes()
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2026-11-20",
        "bindings": [
            {
                "type": "d1",
                "name": "DB",
                "database_id": database_id,
                "database_name": DATABASE_NAME,
            }
        ],
        "vars": {
            "AI_BASE_URL": "https://text.pollinations.ai/openai",
            "AI_MODEL": "openai-fast",
            "PRO_PRICE_PHP": "149",
            "FREE_DAILY_LIMIT": "20",
        },
    }
    boundary = "----waveai" + secrets.token_hex(12)
    parts = []
    parts.append(
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="metadata"\r\n'
        "Content-Type: application/json\r\n\r\n"
        + json.dumps(metadata)
        + "\r\n"
    )
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        "Content-Type: application/javascript+module\r\n\r\n"
    )
    body = (
        parts[0].encode("utf-8")
        + head.encode("utf-8")
        + script
        + f"\r\n--{boundary}--\r\n".encode("utf-8")
    )
    print(f"Uploading Worker '{WORKER_NAME}' ({len(script)} bytes)...")
    payload = cf_request(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{WORKER_NAME}",
        body,
        f"multipart/form-data; boundary={boundary}",
    )
    result = payload.get("result") or {}
    print(f"Worker uploaded: id={result.get('id')} modified={result.get('modified_on')}")


def put_secret(account_id: str, name: str, text: str) -> None:
    body = json.dumps(
        {"name": name, "text": text, "type": "secret_text"}
    ).encode("utf-8")
    cf_request(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{WORKER_NAME}/secrets",
        body,
        "application/json",
    )
    print(f"Secret set: {name}")


def set_secrets(account_id: str) -> None:
    if not SECRET_FILE.exists():
        raise ApiError(
            f"SESSION_SECRET file not found: {SECRET_FILE}. Generate one with "
            "`openssl rand -hex 32` and save it there (mode 600) first."
        )
    session_secret = SECRET_FILE.read_text(encoding="utf-8").strip()
    if len(session_secret) < 32:
        raise ApiError("SESSION_SECRET in the secret file looks too short.")
    put_secret(account_id, "SESSION_SECRET", session_secret)
    put_secret(account_id, "ADMIN_EMAIL", ADMIN_EMAIL)


def check_live(account_id: str) -> str:
    payload = cf_request("GET", f"/accounts/{account_id}/workers/subdomain")
    subdomain = (payload.get("result") or {}).get("subdomain")
    if not subdomain:
        raise ApiError("Could not read the account's workers.dev subdomain.")
    url = f"https://{WORKER_NAME}.{subdomain}.workers.dev"
    healthz = url + "/healthz"
    print(f"Live URL: {url}")
    # The workers.dev route can take a few seconds to propagate.
    last_err = ""
    for attempt in range(1, 7):
        try:
            req = urllib.request.Request(healthz, method="GET")
            with OPENER.open(req, timeout=30) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                print(f"/healthz -> HTTP {resp.status}: {body}")
                if resp.status == 200:
                    return url
                last_err = f"HTTP {resp.status}: {body}"
        except urllib.error.HTTPError as exc:
            last_err = f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}"
        except urllib.error.URLError as exc:
            last_err = f"network error: {exc}"
        print(f"  attempt {attempt}/6 not ready ({last_err}); retrying in 5s...")
        time.sleep(5)
    raise ApiError(f"/healthz did not return 200 after 6 attempts: {last_err}")


def main() -> int:
    print("WAVE AI — Cloudflare API deploy")
    print(f"Repo: {REPO}")
    try:
        account_id = get_account_id()
        database_id = ensure_d1_database(account_id)
        print()
        print(f"DATABASE_ID={database_id}")
        print("(Also patch this into wrangler.toml for future wrangler deploys.)")
        print()
        ensure_build()
        upload_worker(account_id, database_id)
        set_secrets(account_id)
        url = check_live(account_id)
    except (ApiError, DynamicCredentialError, RuntimeError) as exc:
        print(f"\nDEPLOY FAILED: {exc}", file=sys.stderr)
        return 1
    print()
    print("DEPLOY OK — WAVE AI is live at:")
    print(f"  {url}")
    print("Next: sign up with the admin email, open /admin, set the GCash details.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
