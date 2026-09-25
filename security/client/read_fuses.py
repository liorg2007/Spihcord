#!/usr/bin/env python3
"""Read Electron fuse wire from a packaged binary (no deps). Usage: read_fuses.py <Shpihcord.exe>"""
import sys
NAMES = ["RunAsNode", "EnableCookieEncryption", "EnableNodeOptionsEnvironmentVariable",
         "EnableNodeCliInspectArguments", "EnableEmbeddedAsarIntegrityValidation",
         "OnlyLoadAppFromAsar", "LoadBrowserProcessSpecificV8Snapshot",
         "GrantFileProtocolExtraPrivileges", "WasmTrapHandlers"]
data = open(sys.argv[1], "rb").read()
i = data.find(b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX")
if i < 0: sys.exit("fuse sentinel not found")
i += 32
ver, n = data[i], data[i + 1]
wire = data[i + 2:i + 2 + n].decode()
print(f"fuse wire v{ver}: {wire}")
for k, c in enumerate(wire):
    name = NAMES[k] if k < len(NAMES) else f"fuse{k}"
    print(f"  {name:40s} {'ENABLED' if c == '1' else 'DISABLED' if c == '0' else 'removed' if c == 'r' else c}")
