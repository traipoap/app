#!/usr/bin/env python3
"""E2E: register → auto-login → duplicate → validation → role assertions."""
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:18080"
passed = 0
failed = 0


def req(method, path, body=None, headers=None, basic=None):
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    if basic:
        import base64

        h["Authorization"] = "Basic " + base64.b64encode(basic.encode()).decode()
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {extra}")


# 1) register (client tries to smuggle role=admin — must be ignored)
s, d = req("POST", "/api/auth/register", {
    "username": "e2e-user@example.com",
    "password": "secret123",
    "role": "admin",
})
check("register → 201", s == 201, f"got {s} {d}")

# 2) auto-login with Basic auth
s, d = req("POST", "/api/auth/login", basic="e2e-user@example.com:secret123")
check("auto-login → 200 + token", s == 200 and bool(d.get("token")), f"got {s}")
token = d.get("token", "")

# 3) duplicate → 409
s, d = req("POST", "/api/auth/register", {
    "username": "e2e-user@example.com",
    "password": "secret123",
})
check("duplicate register → 409", s == 409, f"got {s} {d}")

# 4) weak password → 400
s, d = req("POST", "/api/auth/register", {
    "username": "x@y.com",
    "password": "short",
})
check("weak password → 400", s == 400, f"got {s} {d}")

# 5) Role escalation must be blocked: new self-registered user must NOT
#    pass the admin-only /api/admin guard (i.e. role stayed "user").
s, d = req("GET", "/api/profile", headers={"Authorization": f"Bearer {token}"})
check("profile → 200", s == 200, f"got {s} {d}")
s, d = req("GET", "/api/admin", headers={"Authorization": f"Bearer {token}"})
check(
    "role escalation blocked (/api/admin → 403)",
    s == 403,
    f"got {s} {d}  ⚠️ if 200 the user is admin!"
)

# 6) user role cannot use admin-only API
s, d = req("GET", "/api/search?query=test", headers={"Authorization": f"Bearer {token}"})
check("/api/search as 'user' → 403", s == 403, f"got {s} {d}")

print(f"\nE2E RESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
