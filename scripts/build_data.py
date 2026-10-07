"""Build app/data/places.json from scripts/places_src.py + data/book.json.

Chinese text is copied verbatim from the EPUB extraction; nothing is
rewritten.  English is used only for anchors and for sanity checks:
  * every quoted fragment in an English-text evidence claim must really occur
    in the English edition;
  * the zh/en length ratio of each scene must look like a translation of the
    same passage, otherwise the scene is flagged needsReview.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from places_src import PLACES, EN_TEXT
from context_src import CONTEXT, PEOPLE

book = json.loads((ROOT / "data" / "book.json").read_text())
zh = {p["id"]: p["text"] for c in book["chapters"] for p in c["paragraphs"]}
zh_title = {c["index"]: c["title"] for c in book["chapters"]}

def norm(s):
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("_", "")
    return re.sub(r"\s+", " ", s).strip()

raw = (ROOT / "research" / "en_1964_fadedpage.txt").read_text(encoding="utf-8", errors="replace").replace("\r", "")
paras = [norm(p) for p in re.split(r"\n\s*\n", raw)]
raw_paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", raw)]
en, cur = [], None
for p, rp in zip(paras, raw_paras):
    if not p:
        continue
    m = re.fullmatch(r"_([^_]{8,70})_", rp)
    if m and not rp.startswith("_Note") and "Torrents" not in rp:
        cur = {"title": m.group(1), "paras": []}; en.append(cur); continue
    if cur:
        cur["paras"].append(p)
en = en[4:]                      # drop title page / contents pseudo-chapters
en_all = " ".join(p for c in en for p in c["paras"])
assert len(en) == 20, len(en)

problems = []
def words(s, n): return " ".join(s.split()[:n])

out = []
for pl in PLACES:
    pl = dict(pl)
    for e in pl["evidence"]:
        if e["url"] != EN_TEXT["url"]:
            continue
        for q in re.findall(r"'((?:[^']|'(?=\w))+)'", e["claim"]):
            for frag in re.split(r"\s*…\s*", q):
                frag = norm(frag).strip(" .,;")
                if len(frag) > 12 and frag not in en_all:
                    problems.append(f"{pl['id']}: quote not found in English text: {frag[:70]}")
    scenes = []
    for n, sc in enumerate(pl.pop("scenes"), 1):
        title, ech, e1, e2, z1, z2, *rest = sc
        review = bool(rest and rest[0])
        zc, a = map(int, z1.split("-")); zc2, b = map(int, z2.split("-"))
        assert zc == zc2
        ids = [f"{zc}-{i}" for i in range(a, b + 1)]
        texts = [zh[i] for i in ids]
        nchar = sum(map(len, texts))
        s = {"id": f"{pl['id']}-{n}", "title": title,
             "chapter": zc, "chapterTitle": zh_title[zc],
             "chineseMatch": {"chapter": zc, "paragraphIds": ids},
             "paragraphs": texts, "chars": nchar,
             "audio": f"audio/{pl['id']}-{n}.m4a"}
        if ech:
            assert ech == zc, "main chapters map 1:1"
            ep = en[ech - 1]["paras"][e1 - 1:e2]
            s["englishChapterTitle"] = en[ech - 1]["title"]
            s["englishAnchorStart"] = words(ep[0], 14)
            s["englishAnchorEnd"] = words(ep[-1], 10)
            s["englishParagraphs"] = [e1, e2]
            ratio = nchar / sum(map(len, ep))
            s["zhEnRatio"] = round(ratio, 3)
            if not 0.2 <= ratio <= 0.42:
                review = True
                problems.append(f"{s['id']}: zh/en length ratio {ratio:.2f} looks off")
        else:
            s["englishChapterTitle"] = None
            s["englishAnchorStart"] = None
        s["needsReview"] = review
        # Editorial background (not book text): shown above the passage and read before it.
        context, people = CONTEXT[s["id"]]
        s["chapterLabel"] = f"第{zc}章" if zc <= 20 else "附录"
        s["context"] = context
        s["people"] = people
        s["intro"] = f"出自《流动的盛宴》{s['chapterLabel']}，《{zh_title[zc].strip('“”')}》。{context}"
        s["introAudio"] = f"audio/{pl['id']}-{n}-intro.m4a"
        assert all(x in PEOPLE for x in people), people
        scenes.append(s)
    pl["scenes"] = scenes
    pl["chapter"] = scenes[0]["chapter"]
    pl["chapterTitle"] = scenes[0]["chapterTitle"]
    pl["englishQuoteOrAnchor"] = scenes[0].get("englishAnchorStart")
    pl["autoplay"] = pl["confidence"] in ("HIGH", "MEDIUM")
    out.append(pl)

(ROOT / "app" / "data").mkdir(parents=True, exist_ok=True)
(ROOT / "app" / "data" / "places.json").write_text(
    json.dumps({"book": book["source"], "englishSource": EN_TEXT,
                "people": {k: {"name": n, "bio": bio} for k, (n, bio) in PEOPLE.items()},
                "places": out}, ensure_ascii=False, indent=1))

tot = 0
for pl in out:
    for s in pl["scenes"]:
        tot += s["chars"]
        print(f"{s['id']:34} {s['chars']:5}字 ~{s['chars']/270:4.1f}min ratio={s.get('zhEnRatio','-')} {'REVIEW' if s['needsReview'] else ''}")
        print("     EN:", s.get("englishAnchorStart")); print("     ZH:", s["paragraphs"][0][:34], "…", s["paragraphs"][-1][-22:])
print(len(out), "places", sum(len(p['scenes']) for p in out), "scenes", tot, "chars")
print("\nPROBLEMS:" if problems else "\nno problems"); [print(" -", p) for p in problems]
