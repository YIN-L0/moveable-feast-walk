#!/bin/bash
# Serve app/ locally and expose it through a temporary HTTPS tunnel so a phone
# can use GPS (browsers only give location to HTTPS pages).  Ctrl-C stops both.
set -e
cd "$(dirname "$0")/../app"
command -v cloudflared >/dev/null || brew install cloudflared
lsof -ti tcp:8765 >/dev/null || { python3 -m http.server 8765 >/dev/null 2>&1 & SERVER=$!; }
trap '[ -n "$SERVER" ] && kill $SERVER' EXIT
echo "等待下面出现 https://xxxx.trycloudflare.com ，用手机打开它："
cloudflared tunnel --url http://localhost:8765
