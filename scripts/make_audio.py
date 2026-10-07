"""Render every scene in app/data/places.json to app/audio/<scene>.m4a.

Usage: make_audio.py [--force] [--intros] [voice]

  voice = zh-CN-YunxiNeural (default) or any other edge-tts voice
          → Microsoft neural voices; the scene text is sent to Microsoft's
            online TTS service.
  voice = Tingting or any other macOS `say` voice
          → synthesised on this machine, nothing leaves it.

With --force everything is rendered into a temporary folder first and only
swapped in when all scenes succeeded, so a failed run never leaves a mix of
two voices.
"""
import asyncio, json, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
VOICE = args[0] if args else "zh-CN-YunxiNeural"
FORCE = "--force" in sys.argv
EDGE = "Neural" in VOICE
RATE = "-6%"     # a little slower than default suits literary prose
INTRO_VOICE = "zh-CN-YunyangNeural" if EDGE else VOICE   # background notes: a different voice from the book text
REDO_INTROS = "--intros" in sys.argv                      # re-render intros after editing context_src.py

def synth_say(paragraphs, out):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        # [[slnc]] gives a paragraph pause without adding any spoken words
        f.write(" [[slnc 500]]\n".join(paragraphs))
    subprocess.run(["say", "-v", VOICE, "-f", f.name, "-o", str(out),
                    "--file-format=m4af", "--data-format=aac@22050", "--bit-rate=40000"], check=True)

def synth_edge(paragraphs, out, voice=None):
    import edge_tts
    voice = voice or VOICE
    mp3 = out.with_suffix(".mp3")
    for attempt in range(4):
        try:
            asyncio.run(edge_tts.Communicate("\n\n".join(paragraphs), voice, rate=RATE).save(str(mp3)))
            break
        except Exception as e:
            if attempt == 3:
                raise
            print("  retry:", e, flush=True)
    subprocess.run(["afconvert", str(mp3), str(out), "-f", "m4af", "-d", "aac", "-b", "48000", "-c", "1"], check=True)
    mp3.unlink()

def duration(path):
    r = subprocess.run(["afinfo", str(path)], capture_output=True, text=True).stdout
    for line in r.splitlines():
        if "estimated duration" in line:
            return round(float(line.split(":")[1].split()[0]))

data_path = ROOT / "app" / "data" / "places.json"
data = json.loads(data_path.read_text())
final = ROOT / "app" / "audio"
work = ROOT / "app" / "audio.tmp" if FORCE else final
work.mkdir(exist_ok=True)

for pl in data["places"]:
    for s in pl["scenes"]:
        out = work / Path(s["audio"]).name
        if not out.exists():
            (synth_edge if EDGE else synth_say)(s["paragraphs"], out)
        s["durationSec"] = duration(out)
        intro = work / Path(s["introAudio"]).name
        if REDO_INTROS or not intro.exists():
            if EDGE:
                synth_edge([s["intro"]], intro, INTRO_VOICE)
            else:
                synth_say([s["intro"]], intro)
        s["introDurationSec"] = duration(intro)
        print(s["id"], s["durationSec"], "s", out.stat().st_size // 1024, "KB", flush=True)

if FORCE:
    shutil.rmtree(final, ignore_errors=True)
    work.rename(final)
data["voice"] = VOICE
data_path.write_text(json.dumps(data, ensure_ascii=False, indent=1))
print("done:", VOICE)
