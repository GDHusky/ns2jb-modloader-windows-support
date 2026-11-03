# ns2jb-modloader

Load **Mario Kart World** RomFS mods on a real Switch 2 using a regular microSD card.

**Private beta.** FS-based game modding has been demonstrated in Mario Kart World and Mario Party Superstars. Other games have not yet been tested.

## 1. Add your mods

Put **all** the mods you want in `MarioKartWorld/mods/`, each in its own folder with `romfs/` inside:

```text
ns2jb-modloader/
└── MarioKartWorld/
    └── mods/
        ├── Characters/
        │   └── romfs/
        │       └── ...mod files...
        ├── 200cc/
        │   └── romfs/
        │       └── System/
        │           └── GymlArchive/
        │               └── ...200cc files...
        └── OtherMod/
            └── romfs/
                └── ...mod files...
```

**No need to install them one by one.** The installer finds all mod folders and loads their RomFS file replacements together. Mods must have their original RomFS file paths. If two mods change the same file, the installer tells you instead of silently overwriting one.

For an extracted 200cc download containing `200cc/romfs/System/GymlArchive/`, copy the **inner `200cc` folder** into `MarioKartWorld/mods/` (not its parent download folder).

You can also use the standard Atmosphère folder layout inside each mod: `atmosphere/contents/0400c3f00006e000/romfs/`.

## 2. One-time PC setup

You need your own Mario Kart World game/update on Switch 2, a microSD card, and a supported **SmileBASIC + ns2jb** setup (tested on firmware 23.0.1).

Install **Node.js, Python 3, Zig and GNU binutils** (`readelf`), and download [ns2jb](https://gitlab.com/kurumuz/ns2jb).

In a terminal (Linux/WSL) opened in `ns2jb-modloader/`, set their locations:

```sh
export NS2_UPSTREAM="/path/to/ns2jb"
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-test.txt
```

The virtual environment may have **any name and location**; `.venv` above is just an example. Python and Zig are found on PATH, so activating your own environment works. You can also set `PYTHON="/path/to/python"` or `ZIG="/path/to/zig"` to select an executable explicitly. No paths from the author's PC are required. Keep `node` and `readelf` on PATH.

This setup is done once. Use the same environment variables and activated Python environment in both terminals.

## 3. Install all mods

**First terminal:**

```sh
node start.cjs
```

Follow the instructions shown by ns2jb in SmileBASIC. Wait until it says **FS 4/4 verified**. Keep this terminal open.

**Second terminal:**

```sh
node install.cjs
```

That's it — **no mod names or RPC session paths to type**. The installer detects the active session, combines the mods and verifies the installation.

When it says **READY**:
1. Stop the first terminal with **Ctrl+C** and let ns2jb finish cleanup.
2. Close SmileBASIC **without restarting** the Switch 2.
3. Open Mario Kart World.

The PC can be disconnected after installation: FS serves the mod files directly from the microSD. The in-memory loader stops working after a reboot, so mods must be installed again for a new boot.

## Notes

This beta currently installs **replacements of existing RomFS files**. Model mods are good candidates. A 200cc mod using RomFS files is also a candidate; mods that need `main`/ExeFS patching are a different path. This is not a claim that other mods or games are incompatible.

A fresh, verified ns2jb session is required for each install. Don't install twice in the same boot. If an unexpected native operation fails, stop and reboot rather than retrying a partially applied hook.

The loader is a source-based beta, not a one-click app. It does not include game assets, firmware, keys or mods from other authors.

**Credits:** [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb). Bundled game-mount helpers adapted from [IZ2S / OunceCake](https://github.com/byizmysh/IZ2S-Platform) (GPL-2.0; see `lib/game-files/COPYING`). No separate OunceCake download is required.
