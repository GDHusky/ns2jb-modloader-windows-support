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

## 2. Set up and install

You need your own Mario Kart World game/update on Switch 2, a microSD card, and a supported **SmileBASIC + ns2jb** setup (tested on firmware 23.0.1).

Install **Node.js, Python 3, Zig and GNU binutils** (`readelf`), and download [ns2jb](https://gitlab.com/kurumuz/ns2jb).

Open a terminal (Linux/WSL) in the downloaded `ns2jb-modloader/` folder. Run these commands once to create a Python environment and install the required packages:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-test.txt
```

`python3 -m venv .venv` creates the environment. `source .venv/bin/activate` activates it **in the current terminal**. Run that activation command again whenever you open another terminal to use the installer; you do not need to recreate the environment or reinstall its packages.

The environment may have **any name and location**; `.venv` is the example used below. If you use another location, replace `.venv/bin/activate` with your environment's `bin/activate` path. Python and Zig are found on PATH. You can also set `PYTHON="/path/to/python"` or `ZIG="/path/to/zig"` to select an executable explicitly. Keep `node` and `readelf` on PATH.

**Choose either 2.a or 2.b below, depending on your current ns2jb session.**

### 2.a. You already have FS 4/4 verified and RPC running

Keep your existing ns2jb host running. Open a **second terminal in `ns2jb-modloader/`** and run:

```sh
source .venv/bin/activate
node install.cjs --run-dir "/path/to/ns2jb/runs/switch2-SESSION"
```

Replace `/path/to/ns2jb/runs/switch2-SESSION` with the actual run directory for the session your host is currently running. It is a `switch2-...` folder inside your ns2jb checkout's `runs/` directory; do not type `SESSION` literally.

The installer checks that run's verified FS 4/4 proof and listening RPC state. Use a session where no modloader has been installed yet. When it says **READY**, go directly to step 3.

### 2.b. You need to start ns2jb first

**First terminal, opened in `ns2jb-modloader/`:** Replace `/path/to/ns2jb` with the folder where you downloaded Kurumuz's ns2jb (the one containing `run.cjs`), then run:

```sh
source .venv/bin/activate
export NS2_UPSTREAM="/path/to/ns2jb"
node start.cjs
```

Follow the instructions shown by ns2jb in SmileBASIC. Wait until it says **FS 4/4 verified**. Keep this terminal open.

**Open a second terminal in `ns2jb-modloader/`:** Use the same ns2jb folder path as in the first terminal and run:

```sh
source .venv/bin/activate
export NS2_UPSTREAM="/path/to/ns2jb"
node install.cjs
```

When using `node start.cjs`, **no mod names or RPC session paths need to be typed**. The installer detects the active session, combines the mods and verifies the installation.

## 3. Open Mario Kart World

Once either installation method says **READY**:

1. Stop the terminal running the ns2jb host with **Ctrl+C** and let ns2jb finish cleanup.
2. Close SmileBASIC **without restarting** the Switch 2.
3. Open Mario Kart World.

The PC can be disconnected after installation: FS serves the mod files directly from the microSD. The in-memory loader stops working after a reboot, so mods must be installed again for a new boot.

## Notes

A verified ns2jb FS 4/4 session with RPC running is required for installation. Don't install twice in the same boot. If an unexpected native operation fails, stop and reboot rather than retrying a partially applied hook.

The loader is a source-based beta, not a one-click app. It does not include game assets, firmware, keys or mods from other authors.

**Credits:** [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb). Bundled game-mount helpers adapted from [IZ2S / OunceCake](https://github.com/byizmysh/IZ2S-Platform) (GPL-2.0; see `lib/game-files/COPYING`). No separate OunceCake download is required.
