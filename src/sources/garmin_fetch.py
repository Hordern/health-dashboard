"""Fetches Garmin Connect data with python-garminconnect and prints it as JSON.

Python is used here only because python-garminconnect is the maintained client
that gets past Garmin's 2026 anti-bot checks. All database work stays in Node
(src/sources/garmin.js), which runs this script and reads its stdout.

  login   Prompts for email/password/MFA on the terminal, prints session tokens.
  import  Reuses an existing local session (default ~/.garminconnect, the one
          the Garmin MCP keeps), checks it works, prints its tokens. Use this
          when Garmin rate-limits fresh logins (429).
  fetch   Reads {"tokens", "start", "end", "have_details"} on stdin and prints
          {"tokens", "activities", "days", "details"}. `details` holds the full
          record (laps, HR zones, second-by-second metrics, weather) for each
          run in the window whose id isn't in `have_details`. Tokens are re-printed because the
          library refreshes them, and the caller must store the new ones.
"""

import getpass
import json
import sys
from datetime import date, timedelta

from garminconnect import Garmin, GarminConnectAuthenticationError

# Exit code meaning "the saved session is dead; Daniel must sign in again".
# Must match SIGN_IN_REQUIRED in garmin.js.
SIGN_IN_REQUIRED = 3


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
    try:
        garmin.login(tokenstore=req["tokens"])
    except GarminConnectAuthenticationError as e:
        # The saved session can't be refreshed (expired or revoked). Only a new
        # sign-in from the laptop fixes this, so tell Node with a distinct exit code.
        sys.stderr.write(f"Garmin session rejected: {e}\n")
        sys.exit(SIGN_IN_REQUIRED)

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

    activities = garmin.get_activities_by_date(req["start"], req["end"])
    have = set(req.get("have_details", []))
    details = {
        str(a["activityId"]): run_details(garmin, a["activityId"])
        for a in activities
        if a.get("activityType", {}).get("typeKey") in RUN_TYPES and a["activityId"] not in have
    }
    print(json.dumps({
        "tokens": garmin.client.dumps(),
        "activities": activities,
        "days": days,
        "details": details,
    }))


RUN_TYPES = {"running", "trail_running", "treadmill_running", "track_running"}


def run_details(garmin, activity_id):
    """Everything Garmin Connect shows for one run, fetched once per run."""
    return {
        "activity": safe(garmin.get_activity, activity_id),
        "splits": safe(garmin.get_activity_splits, activity_id),
        "hr_zones": safe(garmin.get_activity_hr_in_timezones, activity_id),
        "weather": safe(garmin.get_activity_weather, activity_id),
        # Second-by-second metrics (HR, pace, cadence, elevation…), thinned to ~1000 points.
        "metrics": safe(garmin.get_activity_details, activity_id, 1000, 0),
    }


if __name__ == "__main__":
    {"login": login, "import": import_session, "fetch": fetch}[sys.argv[1]]()
