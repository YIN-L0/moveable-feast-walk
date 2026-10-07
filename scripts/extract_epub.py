"""Extract chapters and paragraphs from the Chinese EPUB into data/book.json.

Every paragraph gets a stable id "<chapterIndex>-<paragraphIndex>" so that
scenes can reference the translator's text without ever rewriting it.
"""
import json, re, sys, zipfile, html
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
EPUB = next(ROOT.glob("*.epub"))
OUT = ROOT / "data" / "book.json"

z = zipfile.ZipFile(EPUB)
ncx = ET.fromstring(z.read("toc.ncx"))
ns = {"n": "http://www.daisy.org/z3986/2005/ncx/"}
toc = []
for np_ in ncx.iter("{%s}navPoint" % ns["n"]):
    title = np_.find("n:navLabel/n:text", ns).text.strip()
    src = np_.find("n:content", ns).attrib["src"].split("#")[0]
    toc.append((title, src))

def paragraphs(raw):
    body = re.search(r"<body.*?>(.*)</body>", raw, re.S).group(1)
    out = []
    for m in re.finditer(r"<(p|h[1-6])\b[^>]*>(.*?)</\1>", body, re.S):
        t = re.sub(r"<sup\b.*?</sup>", "", m.group(2), flags=re.S)  # footnote marks
        t = re.sub(r"<[^>]+>", "", t)
        t = html.unescape(t).replace("　", "").strip()
        if t:
            out.append((m.group(1), t))
    return out

chapters = []
for title, src in toc:
    items = paragraphs(z.read(src).decode("utf-8"))
    body = [t for tag, t in items if tag == "p"]
    if len("".join(body)) < 800:   # front matter, image pages, section dividers
        continue
    ci = len(chapters) + 1
    chapters.append({
        "index": ci, "title": title, "file": src,
        "paragraphs": [{"id": f"{ci}-{i+1}", "text": t} for i, t in enumerate(body)],
    })

OUT.write_text(json.dumps({"source": EPUB.name, "chapters": chapters}, ensure_ascii=False, indent=1))
for c in chapters:
    n = sum(len(p["text"]) for p in c["paragraphs"])
    print(c["index"], c["title"], len(c["paragraphs"]), "paras", n, "chars")
