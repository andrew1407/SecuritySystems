"""Packs a disk-model/ tree into JSON: each entry's path, type, mode bits, mtime and base64 content."""
import base64, json, os, stat, sys

root, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(root))
entries = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in [None] + sorted(filenames):
        path = dirpath if name is None else os.path.join(dirpath, name)
        st = os.stat(path)
        entry = {"path": os.path.relpath(path, base), "dir": name is None,
                 "mode": stat.S_IMODE(st.st_mode), "mtime": int(st.st_mtime * 1000)}
        if name is not None:
            with open(path, "rb") as f:
                entry["data"] = base64.b64encode(f.read()).decode()
        entries.append(entry)
with open(out, "w") as f:
    json.dump({"entries": entries}, f, indent=1)
print(f"{out}: {len(entries)} entries")
