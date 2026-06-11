import os
import re
import json
import time
import requests
from flask import Flask, Response, render_template, request, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key")

ACESTREAM_HOST = os.environ.get("ACESTREAM_HOST", "localhost")
ACESTREAM_PORT = os.environ.get("ACESTREAM_PORT", "6878")
ACESTREAM_BASE = f"http://{ACESTREAM_HOST}:{ACESTREAM_PORT}"

SCRAPE_URL = os.environ.get("SCRAPE_URL", "")

FALLBACK_SCRAPE_URL = os.environ.get(
    "FALLBACK_SCRAPE_URL",
    ""
)

STATIC_CHANNELS_PATH = os.path.join(os.path.dirname(__file__), "channels.json")
CACHE_TTL = 86400

channels_cache = None
channels_cache_time = 0


def parse_m3u(content):
    items = []
    lines = content.strip().split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#EXTINF:"):
            info = line[len("#EXTINF:-1 "):]
            group = re.search(r'group-title="([^"]*)"', info)
            tvg_id = re.search(r'tvg-id="([^"]*)"', info)
            logo = re.search(r'tvg-logo="([^"]*)"', info)
            display_name = info.split(",")[-1].strip() if "," in info else ""
            if i + 1 < len(lines):
                url_line = lines[i + 1].strip()
                if url_line.startswith("acestream://"):
                    hash_val = url_line[len("acestream://"):].strip()
                    items.append({
                        "title": display_name,
                        "hash": hash_val,
                        "group": group.group(1) if group else "Otros",
                        "logo": logo.group(1) if logo else "",
                        "tvg_id": tvg_id.group(1) if tvg_id else display_name,
                    })
                    i += 1
        i += 1
    return items


def fetch_channels():
    global channels_cache, channels_cache_time

    now = time.time()
    if channels_cache and (now - channels_cache_time) < CACHE_TTL:
        return channels_cache

    def quality_score(title):
        t = title.lower()
        if "4k" in t or "uhd" in t: return 4
        if "1080" in t or "fhd" in t: return 3
        if "720" in t or "hd" in t: return 2
        if "480" in t or "sd" in t: return 1
        return 0

    scraped_items = []
    try:
        resp = requests.get(SCRAPE_URL, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        scraped_items = data.get("hashes", [])
        if not scraped_items and FALLBACK_SCRAPE_URL:
            print("Primary scrape returned 0 channels, trying fallback...")
            resp2 = requests.get(FALLBACK_SCRAPE_URL, timeout=15)
            resp2.raise_for_status()
            scraped_items = parse_m3u(resp2.text)
    except Exception as e:
        print(f"Primary scrape failed: {e}")
        if FALLBACK_SCRAPE_URL:
            try:
                print("Trying fallback...")
                resp2 = requests.get(FALLBACK_SCRAPE_URL, timeout=15)
                resp2.raise_for_status()
                scraped_items = parse_m3u(resp2.text)
            except Exception as e2:
                print(f"Fallback also failed: {e2}")

    scraped_by_hash = {item["hash"]: item for item in scraped_items if item.get("hash")}

    override_channels = []
    try:
        with open(STATIC_CHANNELS_PATH, "r", encoding="utf-8") as f:
            override_channels = json.load(f)
    except Exception:
        pass

    used_hashes = set()
    for oc in override_channels:
        for v in oc.get("variants", []):
            if v.get("hash"):
                used_hashes.add(v["hash"])

    channels = []
    idx = 0

    for oc in override_channels:
        variants = []
        for v in oc.get("variants", []):
            h = v["hash"]
            scraped = scraped_by_hash.get(h, {})
            variants.append({
                "title": v.get("title") or scraped.get("title", "Unknown"),
                "hash": h,
            })

        if not variants:
            continue

        variants.sort(key=lambda x: quality_score(x["title"]), reverse=True)

        logo = oc.get("logo", "")
        if not logo:
            for v in variants:
                s = scraped_by_hash.get(v["hash"], {})
                if s.get("logo"):
                    logo = s["logo"]
                    break

        channels.append({
            "id": f"ch{idx}",
            "name": oc.get("name", variants[0]["title"]),
            "group": oc.get("group", "Otros"),
            "logo": logo,
            "variants": variants,
            "default_hash": variants[0]["hash"],
        })
        idx += 1

    remaining = [item for item in scraped_items if item.get("hash") and item["hash"] not in used_hashes]

    groups = {}
    for item in remaining:
        channel_key = item.get("tvg_id", "").strip() or item.get("title", "Unknown").strip()
        group_name = item.get("group", "Otros")
        if group_name not in groups:
            groups[group_name] = {}
        if channel_key not in groups[group_name]:
            groups[group_name][channel_key] = {
                "name": channel_key, "logo": "", "variants": [],
            }
        if item.get("logo"):
            groups[group_name][channel_key]["logo"] = item["logo"]
        groups[group_name][channel_key]["variants"].append({
            "title": item.get("title", "Unknown"),
            "hash": item["hash"],
        })

    for group_name in sorted(groups.keys()):
        for ch_name in sorted(groups[group_name].keys()):
            ch = groups[group_name][ch_name]
            ch["variants"].sort(key=lambda v: quality_score(v["title"]), reverse=True)
            channels.append({
                "id": f"ch{idx}",
                "name": ch["name"],
                "group": group_name,
                "logo": ch["logo"],
                "variants": ch["variants"],
                "default_hash": ch["variants"][0]["hash"],
            })
            idx += 1

    channels_cache = channels
    channels_cache_time = now
    return channels


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/channels")
def api_channels():
    return jsonify(fetch_channels())


@app.route("/api/channels/refresh")
def api_channels_refresh():
    global channels_cache, channels_cache_time
    channels_cache = None
    channels_cache_time = 0
    return jsonify(fetch_channels())


@app.route("/api/probe")
def api_probe():
    hash_val = request.args.get("hash", "").strip()
    if not hash_val:
        return jsonify({"error": "Missing hash"}), 400
    try:
        resp = requests.get(
            f"{ACESTREAM_BASE}/ace/manifest.m3u8",
            params={"id": hash_val},
            timeout=6
        )
        if resp.status_code == 200 and "mpegurl" in resp.headers.get("Content-Type", ""):
            return jsonify({"status": "ok"})
        return jsonify({"status": "unavailable"}), 200
    except requests.Timeout:
        return jsonify({"status": "timeout"}), 200
    except Exception:
        return jsonify({"status": "error"}), 200


@app.route("/api/play")
def api_play():
    hash_val = request.args.get("hash", "").strip()
    if not hash_val:
        return jsonify({"error": "Missing hash parameter"}), 400

    channels = fetch_channels()
    found = None
    for ch in channels:
        for v in ch.get("variants", []):
            if v["hash"] == hash_val:
                found = {"channel": ch, "variant": v}
                break
        if found:
            break

    if not found:
        return jsonify({"error": "Hash not found"}), 404

    origin = request.headers.get('X-Forwarded-Proto', request.scheme) + '://' + request.headers.get('X-Forwarded-Host', request.host)
    proxy_url = f"{origin}/proxy/ace/manifest.m3u8?id={hash_val}"
    return jsonify({
        "url": proxy_url,
        "channel": found["channel"],
        "variant": found["variant"],
    })


@app.route("/proxy/<path:path>")
def proxy(path):
    url = f"{ACESTREAM_BASE}/{path}"
    params = dict(request.args)

    try:
        resp = requests.get(url, params=params, stream=True, timeout=30)
    except requests.exceptions.RequestException as e:
        return Response(f"Proxy error: {e}", status=502)

    excluded_headers = {
        "content-encoding", "content-length", "transfer-encoding", "connection",
    }
    headers = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in excluded_headers
    }

    content_type = resp.headers.get("Content-Type", "").lower()

    if "mpegurl" in content_type or "m3u8" in content_type:
        text = resp.text
        # Rewrite full http/https URLs to relative proxy paths
        text = re.sub(r'https?://[^/\s]+(/ace/)', r'/proxy/\1', text)
        # Rewrite absolute paths starting with /ace/
        text = re.sub(r'(?m)^(?!\s*#)(?!\s*$)(/ace/)', r'/proxy/\1', text)
        # Rewrite relative URLs (paths without leading / or #)
        text = re.sub(
            r'(?m)^(?!\s*#)(?!\s*$)(?!https?://)(?!\s*/)(\S+)$',
            r'/proxy/ace/\1',
            text
        )
        return Response(
            text, status=resp.status_code, headers=headers,
            content_type=resp.headers.get("Content-Type")
        )

    return Response(
        resp.iter_content(chunk_size=8192),
        status=resp.status_code,
        headers=headers,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
