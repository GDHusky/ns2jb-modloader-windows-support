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

Install **Node.js, Python 3, Zig and GNU binutils** (`readelf`). This project uses an externally established **ns2jb FS 4/4 session with RPC running**. Set up [ns2jb](https://gitlab.com/kurumuz/ns2jb) separately using your preferred workflow; this repository does not download or launch it.

Open a terminal (Linux/WSL) in the downloaded `ns2jb-modloader/` folder. Run these commands once to create a Python environment and install the required packages:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

`python3 -m venv .venv` creates the environment. `source .venv/bin/activate` activates it **in the current terminal**. Run that activation command again whenever you open another terminal to use the installer; you do not need to recreate the environment or reinstall its packages.

The environment may have **any name and location**; `.venv` is the example used below. If you use another location, replace `.venv/bin/activate` with your environment's `bin/activate` path. Python and Zig are found on PATH. You can also set `PYTHON="/path/to/python"` or `ZIG="/path/to/zig"` to select an executable explicitly. Keep `node` and `readelf` on PATH.

With **FS 4/4 verified and RPC running**, keep your ns2jb host open. In a **second terminal in `ns2jb-modloader/`**, run:

```sh
source .venv/bin/activate
node install.cjs --run-dir "/path/to/ns2jb/runs/switch2-SESSION"
```

Replace `/path/to/ns2jb/runs/switch2-SESSION` with the actual run directory for the session your host is currently running. It is a `switch2-...` folder inside your ns2jb checkout's `runs/` directory; do not type `SESSION` literally.

The installer checks that run's verified FS 4/4 proof and listening RPC state. Use a session where no modloader has been installed yet. When it says **READY**, go directly to step 3.

You can check the mod folder layout without contacting the console:

```sh
node install.cjs --check
```

## 3. Open Mario Kart World

Once the installer says **READY**:

1. Stop the terminal running the ns2jb host with **Ctrl+C** and let ns2jb finish cleanup.
2. Close SmileBASIC **without restarting** the Switch 2.
3. Open Mario Kart World.

The PC can be disconnected after installation: FS serves the mod files directly from the microSD. The in-memory loader stops working after a reboot, so mods must be installed again for a new boot.

## Notes

**Mod compatibility:** Some older Switch 1 mods that include ExeFS patches may not work with certain games unless they've been updated for 64-bit. For example, [Mario Kart 8 Deluxe changed from ARM32 through version 3.0.3 to ARM64 in version 3.0.4](https://github.com/mdietz94/mk8dx_ap/blob/eb7883cf1e8d45f8e8df73549beb4add81050abf/switch-mod/config/config.cmake). Most Switch 1 games were already 64-bit, so this does not affect every game. ExeFS patches must also match the game's version or Build ID, even when its architecture has not changed. RomFS mods may still work as long as the game's file formats and paths have not changed.

A verified ns2jb FS 4/4 session with RPC running is required for installation. Don't install twice in the same boot. If an unexpected native operation fails, stop and reboot rather than retrying a partially applied hook.

The loader is a source-based beta, not a one-click app. It does not include game assets, firmware, keys or mods from other authors.

**Credits:** [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb). Bundled game-mount helpers adapted from [IZ2S / OunceCake](https://github.com/byizmysh/IZ2S-Platform) (GPL-2.0; see `lib/game-files/COPYING`). No separate OunceCake download is required.
