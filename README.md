# ns2jb-modloader

**Load Mario Kart World RomFS mods on a real Switch 2, using a regular microSD card.**

Private beta — tested with Mario Kart World. The same FS replacement technique has also been demonstrated with Mario Party Superstars. Other games have not yet been tested.

The mod remains active after closing SmileBASIC. It lasts until you reboot the console; the original installed game files are not changed.

## What you need

- Switch 2 with the supported SmileBASIC/ns2jb exploit (tested on firmware **23.0.1**).
- Your own installed **Mario Kart World** and a regular microSD card containing a `/roms` folder.
- A PC for **initial setup only**. Node.js, Python 3, Zig, and the following two projects:
  - [Kurumuz's ns2jb](https://gitlab.com/kurumuz/ns2jb)
  - [OunceCake from IZ2S-Platform](https://github.com/byizmysh/IZ2S-Platform) (`modules/iz-exchange/server/ouncecake/engine`)

Set these paths in your terminal (Linux/WSL):

```sh
export NS2_UPSTREAM="/path/to/ns2jb"
export OUNCECAKE_ENGINE="/path/to/IZ2S-Platform/modules/iz-exchange/server/ouncecake/engine"
export ZIG="$(command -v zig)"
python3 -m venv research/superstars-mod/.venv
research/superstars-mod/.venv/bin/pip install -r requirements-test.txt
```

## Install a mod

**1. Put the mod files inside a `romfs` folder.** Keep the original folder paths. You can combine model and other RomFS replacements in **one** folder:

```text
mods/
  MyMod/
    romfs/
      ...same file paths as in Mario Kart World's RomFS...
```

**2. Start ns2jb** (with the usual Switch 2 LAN/SmileBASIC connection):

```sh
node start.cjs
```

On the Switch, use the START command shown by ns2jb. Wait until **FS 4/4** is verified. Keep this terminal open.

**3. In a second terminal, install the mod:**

```sh
node install.cjs mods/MyMod "/path/to/current/ns2jb/runs/switch2-XXXXXX"
```

Use the **new run directory from this session**, not an old one. If the command prints **READY**, stop the first terminal with Ctrl+C and wait for ns2jb to finish its cleanup. Then close SmileBASIC (do **not** reboot), and open Mario Kart World.

That's it. The mod is served by the console's FS process from microSD, so the PC is no longer needed once installation is complete.

## Notes

- This first beta handles **replacements of existing RomFS files**. Model mods are a good first test. A 200cc mod also fits if it replaces RomFS resources; patches to the game's `main` executable use a separate CodeFS method.
- The installer validates your game's actual file paths/version and refuses mismatches. An untested game is **not** the same as an incompatible game.
- Don't run installation twice in the same session. If a native operation fails after the hook starts, **reboot before retrying**; don't force cleanup or reuse a previous session.
- This is a source-based tester build, **not yet a one-click release**. No Nintendo files, game assets, firmware, keys or other people's mods are included.

Credits: [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb), [OunceCake](https://github.com/byizmysh/IZ2S-Platform). The FS-resident mod reader and handoff implementation are documented in the source.
