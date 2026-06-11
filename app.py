import os
import re
import json
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
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

EPG_URL = os.environ.get("EPG_URL", "")

STATIC_CHANNELS_PATH = os.path.join(os.path.dirname(__file__), "channels.json")
CACHE_TTL = 86400
EPG_CACHE_TTL = int(os.environ.get("EPG_CACHE_TTL", "3600"))

channels_cache = None
channels_cache_time = 0
epg_cache = None
epg_cache_time = 0


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


def parse_epg_time(timestr):
    m = re.match(r'(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) ([+-]\d{2})(\d{2})', timestr)
    if not m:
        return None
    offset_h = int(m.group(7))
    offset_m = int(m.group(8))
    if offset_h < 0:
        offset_m = -offset_m
    tz = timezone(timedelta(hours=offset_h, minutes=offset_m))
    return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                    int(m.group(4)), int(m.group(5)), int(m.group(6)), tzinfo=tz)


def fetch_epg():
    global epg_cache, epg_cache_time
    if not EPG_URL:
        return {}
    now = time.time()
    if epg_cache and (now - epg_cache_time) < EPG_CACHE_TTL:
        return epg_cache

    try:
        resp = requests.get(EPG_URL, timeout=30)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    except Exception as e:
        print(f"EPG fetch failed: {e}")
        if epg_cache:
            return epg_cache
        return {}

    epg_channels = {}
    for ch in root.findall("channel"):
        ch_id = ch.get("id", "")
        display_names = [dn.text or "" for dn in ch.findall("display-name")]
        epg_channels[ch_id] = display_names

    now_dt = datetime.now(timezone.utc)

    epg_data = {}
    for prog in root.findall("programme"):
        ch_id = prog.get("channel", "")
        start_str = prog.get("start", "")
        stop_str = prog.get("stop", "")
        start_dt = parse_epg_time(start_str)
        stop_dt = parse_epg_time(stop_str)
        if not start_dt or not stop_dt:
            continue
        title_el = prog.find("title")
        desc_el = prog.find("desc")
        entry = {
            "start": start_str,
            "stop": stop_str,
            "start_ts": start_dt.timestamp(),
            "stop_ts": stop_dt.timestamp(),
            "title": title_el.text if title_el is not None else "",
            "desc": desc_el.text if desc_el is not None else "",
        }
        if ch_id not in epg_data:
            epg_data[ch_id] = []
        epg_data[ch_id].append(entry)

    result = {
        "channels": epg_channels,
        "programmes": epg_data,
    }
    epg_cache = result
    epg_cache_time = now
    return result


def clean_channel_name(name):
    cleaned = re.sub(r'\s*\*+', '', name)
    cleaned = re.sub(r'\s+\d+p', '', cleaned)
    cleaned = re.sub(r'\s+(4K|UHD|FHD|HD|SD)$', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s+\d+$', '', cleaned)
    return cleaned.strip()


def match_channel_to_epg(channel_name, epg_channels):
    cleaned = clean_channel_name(channel_name).lower()
    if not cleaned:
        return None

    for ch_id, display_names in epg_channels.items():
        if clean_channel_name(ch_id).lower() == cleaned:
            return ch_id
        for dn in display_names:
            if clean_channel_name(dn).lower() == cleaned:
                return ch_id

    for ch_id, display_names in epg_channels.items():
        if cleaned in clean_channel_name(ch_id).lower():
            return ch_id
        for dn in display_names:
            if cleaned in clean_channel_name(dn).lower():
                return ch_id

    return None


def get_current_programme(ch_id, epg_data):
    now_ts = time.time()
    programmes = epg_data.get(ch_id, [])
    for p in programmes:
        if p["start_ts"] <= now_ts < p["stop_ts"]:
            return p
    return None


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

    epg_data = fetch_epg()
    epg_channels_map = epg_data.get("channels", {})
    epg_progs = epg_data.get("programmes", {})

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

        channel_name = oc.get("name", variants[0]["title"])

        ch = {
            "id": f"ch{idx}",
            "name": channel_name,
            "group": oc.get("group", "Otros"),
            "logo": logo,
            "variants": variants,
            "default_hash": variants[0]["hash"],
        }

        tvg_id = oc.get("tvg_id", "")
        if tvg_id and tvg_id in epg_channels_map:
            ch["epg_channel_id"] = tvg_id
        else:
            epg_match = match_channel_to_epg(channel_name, epg_channels_map)
            if epg_match:
                ch["epg_channel_id"] = epg_match

        if ch.get("epg_channel_id") and ch["epg_channel_id"] in epg_progs:
            current = get_current_programme(ch["epg_channel_id"], epg_progs)
            if current:
                ch["epg_now"] = {
                    "title": current["title"],
                    "start": current["start"],
                    "stop": current["stop"],
                }

        channels.append(ch)
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
                "name": channel_key, "logo": "", "variants": [], "tvg_id": item.get("tvg_id", ""),
            }
        if item.get("logo"):
            groups[group_name][channel_key]["logo"] = item["logo"]
        groups[group_name][channel_key]["variants"].append({
            "title": item.get("title", "Unknown"),
            "hash": item["hash"],
        })

    for group_name in sorted(groups.keys()):
        for ch_name in sorted(groups[group_name].keys()):
            ch_data = groups[group_name][ch_name]
            ch_data["variants"].sort(key=lambda v: quality_score(v["title"]), reverse=True)
            ch = {
                "id": f"ch{idx}",
                "name": ch_data["name"],
                "group": group_name,
                "logo": ch_data["logo"],
                "variants": ch_data["variants"],
                "default_hash": ch_data["variants"][0]["hash"],
            }
            tvg_id = ch_data.get("tvg_id", "")
            if tvg_id and tvg_id in epg_channels_map:
                ch["epg_channel_id"] = tvg_id
            else:
                epg_match = match_channel_to_epg(ch_data["name"], epg_channels_map)
                if epg_match:
                    ch["epg_channel_id"] = epg_match

            if ch.get("epg_channel_id") and ch["epg_channel_id"] in epg_progs:
                current = get_current_programme(ch["epg_channel_id"], epg_progs)
                if current:
                    ch["epg_now"] = {
                        "title": current["title"],
                        "start": current["start"],
                        "stop": current["stop"],
                    }

            channels.append(ch)
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


@app.route("/api/epg/now")
def api_epg_now():
    epg_data = fetch_epg()
    epg_progs = epg_data.get("programmes", {})
    result = {}
    for ch_id in epg_progs:
        current = get_current_programme(ch_id, epg_progs)
        if current:
            result[ch_id] = {
                "title": current["title"],
                "start": current["start"],
                "stop": current["stop"],
            }
    return jsonify(result)


@app.route("/api/epg/guide")
def api_epg_guide():
    channel_id = request.args.get("channel", "")
    if not channel_id:
        return jsonify({"error": "Missing channel"}), 400

    epg_data = fetch_epg()
    epg_progs = epg_data.get("programmes", {})

    channels = fetch_channels()
    ch = next((c for c in channels if c["id"] == channel_id), None)
    if not ch:
        return jsonify({"error": "Channel not found"}), 404

    epg_ch_id = ch.get("epg_channel_id")
    if not epg_ch_id:
        return jsonify({"channel": ch, "programmes": []})

    programmes = epg_progs.get(epg_ch_id, [])
    programmes.sort(key=lambda p: p["start_ts"])

    now_ts = time.time()
    result = []
    for p in programmes:
        result.append({
            "title": p["title"],
            "desc": p["desc"],
            "start": p["start"],
            "stop": p["stop"],
            "start_ts": p["start_ts"],
            "stop_ts": p["stop_ts"],
            "is_now": p["start_ts"] <= now_ts < p["stop_ts"],
        })

    return jsonify({
        "channel": ch,
        "programmes": result,
    })


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
        text = re.sub(r'https?://[^/\s]+(/ace/)', r'/proxy/\1', text)
        text = re.sub(r'(?m)^(?!\s*#)(?!\s*$)(/ace/)', r'/proxy/\1', text)
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
