#!/usr/bin/env python3
"""Minimal local OpenAI-compatible shim for Anthropic /v1/chat/completions.

Adapts transport/schema constraints without changing prompt, rubric, or semantics:
1. Drops deprecated `temperature` if present.
2. Translates `grade` union+enum to Anthropic-compatible `anyOf`.
3. Constrains `candidate_id` and `evidence[].field` enums strictly to keys/IDs present in that packet payload
   so constrained decoding emits exact `bench.field_value()` paths (e.g. `presentations[0].cip13`).

This shim listens on loopback but forwards to a remote provider, so `bench.py judge` sees a local
URL and would skip its remote-transfer approval. The approval is therefore enforced here: the shim
refuses to start without APPROVED_PACKETS_SHA256 (the reviewed `packets_sha256`), and rejects with
403, before any forwarding, a request whose X-Bench-Reviewed-Packets-Sha256 header differs.

    APPROVED_PACKETS_SHA256=<hash> python anthropic_schema_shim.py 18492
    python bench.py judge ... --base-url http://127.0.0.1:18492/v1 --reviewed-packets-sha256 <hash>
"""

import copy
import hmac
import http.server
import re
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

UPSTREAM = "https://api.anthropic.com/v1/chat/completions"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Upstream redirect refused")


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def collect_paths(obj, prefix=""):
    paths = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else k
            if isinstance(v, list):
                for i, item in enumerate(v):
                    paths.extend(collect_paths(item, f"{p}[{i}]"))
                if p:
                    paths.append(p)
            elif isinstance(v, dict):
                paths.extend(collect_paths(v, p))
                if p:
                    paths.append(p)
            elif v not in (None, ""):
                paths.append(p)
    return paths


def extract_payload_constraints(messages):
    for msg in reversed(messages or []):
        if msg.get("role") == "user" and isinstance(msg.get("content"), str):
            try:
                payload = json.loads(msg["content"])
                cands = payload.get("candidates") or []
                cids = [c["candidate_id"] for c in cands if isinstance(c, dict) and "candidate_id" in c]
                paths = sorted({pt for c in cands if isinstance(c, dict) for pt in collect_paths(c.get("evidence"))})
                return cids, paths
            except Exception:
                return [], []
    return [], []


def adapt_request(body):
    out = copy.deepcopy(body)
    out.pop("temperature", None)
    cids, paths = extract_payload_constraints(out.get("messages"))
    rf = out.get("response_format")
    if isinstance(rf, dict) and rf.get("type") == "json_schema":
        js = rf.get("json_schema")
        if isinstance(js, dict) and isinstance(js.get("schema"), dict):
            props = js["schema"].get("properties", {})
            cands = props.get("candidates", {})
            items = cands.get("items", {})
            cprops = items.get("properties", {}) if isinstance(items, dict) else {}
            if "grade" in cprops:
                cprops["grade"] = {
                    "anyOf": [
                        {"type": "integer", "enum": [0, 1, 2, 3]},
                        {"type": "null"},
                    ]
                }
            if cids and "candidate_id" in cprops:
                cprops["candidate_id"] = {"type": "string", "enum": cids}
            if paths and "evidence" in cprops:
                ev_items = cprops["evidence"].get("items", {})
                ev_props = ev_items.get("properties", {}) if isinstance(ev_items, dict) else {}
                if "field" in ev_props:
                    ev_props["field"] = {"type": "string", "enum": paths}
    return out


def approved_hash_from_env():
    value = os.getenv("APPROVED_PACKETS_SHA256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise SystemExit("APPROVED_PACKETS_SHA256 must be the reviewed packets_sha256 (64 hex chars)")
    return value


def request_is_approved(headers, approved):
    sent = headers.get("X-Bench-Reviewed-Packets-Sha256") or ""
    return bool(approved) and hmac.compare_digest(sent, approved)


class Handler(http.server.BaseHTTPRequestHandler):
    approved = None

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_error(404)
            return
        if not request_is_approved(self.headers, self.approved):
            self.send_error(403, "Packets not approved for remote transfer")
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        req_body = adapt_request(json.loads(raw.decode("utf-8")))
        auth = self.headers.get("Authorization") or (
            "Bearer " + os.getenv("ANTHROPIC_API_KEY", "")
        )
        upstream_req = urllib.request.Request(
            UPSTREAM,
            data=json.dumps(req_body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": auth},
        )
        try:
            with OPENER.open(upstream_req, timeout=180) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            err = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    Handler.approved = approved_hash_from_env()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18492
    srv = ThreadedServer(("127.0.0.1", port), Handler)
    srv.serve_forever()
