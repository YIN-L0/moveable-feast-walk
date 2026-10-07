# 流动的盛宴 · 巴黎漫步

走到《流动的盛宴》里写过的地方，听书里发生在那里的那一段（张佳玮译，果麦版 EPUB 原文）。

## 目录

- `app/` — 手机网页本体（纯静态，可离线）。`data/places.json` 是地点库，`audio/` 是每个场景的朗读。
- `scripts/places_src.py` — **研究成果**：地点、历史地址、坐标、证据、英文锚点、中文段落范围。要增删地点改这里。
- `scripts/context_src.py` — 每个场景的背景介绍和人物小传（我写的导读，不是原文；朗读时用另一个声音）。
- `scripts/fetch_metro.py` → `app/data/metro.json`：地铁 / RER 站位置（来自 OpenStreetMap）。
- `scripts/extract_epub.py` → `data/book.json`：EPUB 逐段抽取，段落 id 为 `章-段`。
- `scripts/build_data.py` → `app/data/places.json`：按段落 id 取中文原文，并做两项校验
  （证据里的英文引文必须逐字出现在英文原书；中英场景长度比例必须像同一段的译文，否则标 `needsReview`）。
- `scripts/make_audio.py` → `app/audio/*.m4a`：合成朗读（默认微软神经语音男声，也可用 macOS `say` 本机合成），并把时长写回 `places.json`。
- `research/` — 英文 1964 版全文（仅用于锚点与校验，不随网页发布）和地理编码结果。

## 重新生成

```sh
python3 scripts/extract_epub.py
python3 scripts/build_data.py
python3 scripts/make_audio.py --intros  # 改了背景介绍后只重做介绍的配音
python3 scripts/make_audio.py --force   # 默认男声 zh-CN-YunxiNeural（文本会发给微软在线 TTS）；换声音就在后面加声音名，如 zh-CN-YunyangNeural，或 Tingting（本机合成）
```

## 本机预览

```sh
cd app && python3 -m http.server 8765   # http://localhost:8765
```

不在巴黎时，点任一地点 →“模拟到达这里”即可测试自动播放。

## 在手机上用（需要 HTTPS）

手机浏览器只在 HTTPS 下提供定位。`scripts/serve_phone.sh` 会启动本机服务并开一条临时的 Cloudflare 隧道，
打印出一个 `https://….trycloudflare.com` 地址：

```sh
bash scripts/serve_phone.sh
```

用手机打开那个地址 → 点“下载全部音频以便离线” → 之后即使关掉电脑，已打开的页面也能继续用
（地图底图仍需手机流量）。注意：拿到这个地址的人都能访问书的译文和朗读，地址是随机且临时的，用完按 Ctrl-C 关闭即可。
