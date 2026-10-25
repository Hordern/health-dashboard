"""Fetches Garmin Connect data with python-garminconnect and prints it as JSON.

Python is used here only because python-garminconnect is the maintained client
that gets past Garmin's 2026 anti-bot checks. All database work stays in Node
(src/sources/garmin.js), which runs this script and reads its stdout.

  login   Prompts for email/password/MFA on the terminal, prints session tokens.
  import  Reuses an existing local session (default ~/.garminconnect, the one
          the Garmin MCP keeps), checks it works, prints its tokens. Use this
          when Garmin rate-limits fresh logins (429).
  fetch   Reads {"tokens", "start", "end"} on stdin and prints
          {"tokens", "activities", "days"}. Tokens are re-printed because the
          library refreshes them, and the caller must store the new ones.
"""

import getpass
import json
import sys
from datetime import date, timedelta

from garminconnect import Garmin


def prompt(label):
    sys.stderr.write(label)
    sys.stderr.flush()
    return sys.stdin.readline().strip()


def login():
    email = prompt("Garmin email: ")
    password = getpass.getpass("Garmin password: ")
    garmin = Garmin(email, password, prompt_mfa=lambda: prompt("Garmin MFA code: "))
    garmin.login()
    print(garmin.client.dumps())


def import_session():
    # login() with a tokenstore loads the saved session (refreshing it if needed)
    # and loads the profile, so a dead session fails here rather than later.
    path = sys.argv[2] if len(sys.argv) > 2 else "~/.garminconnect"
    garmin = Garmin()
    garmin.login(tokenstore=path)
    print(garmin.client.dumps())


def safe(fn, *args):
    """One failing endpoint shouldn't lose the rest of the day's data."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 - reported back to Node as data
        return {"error": f"{type(e).__name__}: {e}"}


def fetch():
    req = json.load(sys.stdin)
    garmin = Garmin()
    garmin.login(tokenstore=req["tokens"])

    start, end = date.fromisoformat(req["start"]), date.fromisoformat(req["end"])
    days = []
    d = start
    while d <= end:
        iso = d.isoformat()
        days.append({
            "date": iso,
            "summary": safe(garmin.get_user_summary, iso),
            "sleep": safe(garmin.get_sleep_data, iso),
            "hrv": safe(garmin.get_hrv_data, iso),
            "readiness": safe(garmin.get_training_readiness, iso),
        })
        d += timedelta(days=1)

    print(json.dumps({
        "tokens": garmin.client.dumps(),
        "activities": garmin.get_activities_by_date(req["start"], req["end"]),
        "days": days,
    }))


if __name__ == "__main__":
    {"login": login, "import": import_session, "fetch": fetch}[sys.argv[1]]()
