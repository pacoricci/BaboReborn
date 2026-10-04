"""Build the CC0 coverage bank: python3 devtools/assets/audio/build.py SOURCE_DIRECTORY.

Download the archives in sources.json, extract under PACK/unpacked (7z included),
and leave standalone files under PACK. Requires ffmpeg; never downloads at build time.
"""

import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave


def build(source_root):
    root = Path(__file__).resolve().parents[3]
    manifest = json.loads(Path(__file__).with_name("sources.json").read_text())
    output = root / "frontend/public/audio/coverage"
    output.mkdir(parents=True, exist_ok=True)
    credits = ["# Additional sound effects", "", "All recordings below: CC0-1.0. See CC0-1.0.txt.",
               "These credits apply only to audio/coverage, not other audio directories.", "",
               "Trimmed, downmixed, peak-normalized and faded; loops use an overlap crossfade.",
               "Reproduction and source hashes: devtools/assets/audio/sources.json and build.py.", "",
               "| File | Original | Author | Source |", "| --- | --- | --- | --- |"]
    for entry in manifest["samples"]:
        source = source_root / entry["pack"] / entry["file"]
        if hashlib.sha256(source.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Source hash mismatch: {source}")
        raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source),
                                       "-ss", str(entry["start"]), "-t", str(entry["seconds"]),
                                       "-f", "f32le", "-ac", "1", "-ar", "44100", "-"])
        values = array.array("f", raw)
        if sys.byteorder != "little":
            values.byteswap()
        if entry["reverse"]:
            values.reverse()
        if entry["loop"]:
            overlap = min(2205, len(values) // 4)
            blended = [values[-overlap+i] * (1-i/overlap) + values[i] * i/overlap
                       for i in range(overlap)]
            values = array.array("f", blended) + values[overlap:-overlap]
        else:
            # Keep short transients immediate and remove cut tails without clicks.
            fade = min(882, len(values) // 4)
            for i in range(fade):
                values[i] *= i / fade
                values[-1-i] *= i / fade
        peak = max(abs(v) for v in values)
        if peak < 0.0001:
            raise ValueError(f"Silent selection: {source}")
        pcm = array.array("h", (round(v / peak * 22000) for v in values))
        if sys.byteorder != "little":
            pcm.byteswap()
        with wave.open(str(output / (entry["name"] + ".wav")), "wb") as wav:
            wav.setparams((1, 2, 44100, 0, "NONE", "not compressed"))
            wav.writeframes(pcm.tobytes())
        pack = manifest["packs"][entry["pack"]]
        credits.append(f"| {entry['name']}.wav | {Path(entry['file']).name} | {pack['author']} | [{entry['pack']}]({pack['page']}) |")
    (output / "CREDITS.md").write_text("\n".join(credits) + "\n")


if __name__ == "__main__":
    build(Path(sys.argv[1]))
