# ns2jb-modloader

Load **RomFS and ExeFS mods by Title ID** on Switch 2, directly from microSD.

**Supported firmware: 23.0.1.** Requires an existing **ns2jb FS 4/4 session with RPC running**.

[Download the latest release](https://github.com/SebaaMG/ns2jb-modloader/releases/latest/download/ns2jb-modloader.zip) and extract it, or clone this repository.

**Mod compatibility:** Some older Switch 1 mods that include ExeFS patches may not work with certain games unless they've been updated for 64-bit. For example, [Mario Kart 8 Deluxe changed from ARM32 through version 3.0.3 to ARM64 in version 3.0.4](https://github.com/mdietz94/mk8dx_ap/blob/eb7883cf1e8d45f8e8df73549beb4add81050abf/switch-mod/config/config.cmake). Most Switch 1 games were already 64-bit, so this does not affect every game. ExeFS patches must also match the game's version or Build ID, even when its architecture has not changed. RomFS mods may still work as long as the game's file formats and paths have not changed.

## 1. Add your mods

Put your mod files in **`ns2jb-modloader/contents/<TITLE_ID>/romfs/`** or **`exefs/`**, using each game's 16-digit Title ID. You can have mods for several games together:

```text
ns2jb-modloader/
└── contents/
    ├── 0400c3f00006e000/              # Mario Kart World
    │   └── romfs/
    │       ├── ...character mod files...
    │       └── System/
    │           └── GymlArchive/
    │               └── ...200cc files...
    └── ...other game's Title ID.../
        ├── romfs/
        │   └── ...mod files...
        └── exefs/
            └── ...replacement or additional modules...
```

**No need to install them one by one.** One command prepares the mods for all selected games. Each mod applies to its own Title ID, and the installed loader stays active when you close SmileBASIC and switch between games, until the console reboots. Mods must keep their game-relative file paths. Merge their `contents/` folders when adding several mods.

For example, if you want to install the 200cc mod for Mario Kart World and the download contains `200cc/romfs/System/GymlArchive/`, copy its `romfs/` folder into `ns2jb-modloader/contents/0400c3f00006e000/`. Keep the paths inside `romfs/` unchanged.

*You can also drag and drop your Atmosphère `contents` folder into `ns2jb-modloader/` (as long as your mods are compatible).* Copy `contents/` itself, not the outer `atmosphere/` folder. This gives you exactly the layout shown above; no conversion or extra option is needed.

If a mod includes `exefs_patches/`, copy that folder beside `contents/`, keeping `<PATCH_NAME>/<BUILD_ID>.ips` inside it. No separate OunceCake download is required.

RomFS supports file replacements, new files/directories and `romfs.bin`. ExeFS supports replacement/additional files, `.stub` markers, `exefs.nsp` and IPS/IPS32 module patches. Keep all parts of a combined mod together. Runtime cheats and plugins such as SaltyNX need a separate runtime and are not part of LayeredFS.

## 2. Set up and install

You need your own games/updates on Switch 2, a microSD card, and a supported **SmileBASIC + ns2jb** setup.

Install **Node.js 22 or newer, Python 3, Zig 0.15.2 and GNU binutils** (`readelf`). Set up [ns2jb](https://gitlab.com/kurumuz/ns2jb) separately using your preferred workflow and keep its **FS 4/4 session with RPC running** open.

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

## 3. Open your games

Once the installer says **READY**:

1. Stop the terminal running the ns2jb host with **Ctrl+C** and let ns2jb finish cleanup.
2. Close SmileBASIC **without restarting** the Switch 2.
3. Open any of the games whose mods you installed.

The PC can be disconnected after installation: FS serves the mod files directly from the microSD. The in-memory loader stops working after a reboot, so mods must be installed again for a new boot.

## Notes

A verified ns2jb FS 4/4 session with RPC running is required for installation. Don't install twice in the same boot. If an unexpected native operation fails, stop and reboot rather than retrying a partially applied hook.

Tested on firmware 23.0.1 with a regular microSD: multi-title RomFS/ExeFS content, directory listings and additional files. microSD Express uses the same SD filesystem interface but has not yet been tested on hardware.

This release builds its native components during installation. It does not include game assets, firmware, keys or mods from other authors. Licensed under [GPL-2.0](LICENSE).

**Credits:** [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb). Bundled game-mount helpers adapted from [IZ2S / OunceCake](https://github.com/byizmysh/IZ2S-Platform) (GPL-2.0; see `lib/game-files/COPYING`). ZBIC decompression uses [Atmosphère's Zstandard fork](https://github.com/Atmosphere-NX/Atmosphere/blob/6b0c077b4c608a3a2ee712b8dc35fee87ceb62e8/libraries/libstratosphere/source/util/zstd.inc), bundled under GPL-2.0 in `native/vendor/zstd/`. No separate OunceCake download is required.
