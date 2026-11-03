# ns2jb-modloader

**Nintendo Switch 2 game modding through native FS resource replacement.**

**Status: private Mario Kart World tester preview (source-based, experimental).** This repository contains the existing mod loader research implementation and a guide for trying a small, user-supplied RomFS replacement. It is not an automated installer or a packaged one-click release.

## What has actually been demonstrated

- **Mario Party Superstars:** the Monopoly Party mod was loaded from a regular microSD card and remained active after closing SmileBASIC, without rebooting.
- **Mario Kart World:** native FS redirection has delivered modified resources to the game; custom Knockout Tour content has reached the countdown and driving in a real console. Full custom Knockout Tour gameplay remains under development.
- The mechanism runs a small resource reader inside the FS sysmodule. After a qualified installation and restoration of the stock RO service, the game can run with SmileBASIC closed. The installed in-memory modification lasts until reboot.

These are **tested examples**, not an exhaustive compatibility list. Other games and modifications have not yet been evaluated.

## What to try first

For the first external tester, start with **an existing Mario Kart World RomFS mod** (for example, a model replacement). The helper accepts files in a normal `romfs/` directory, matches them against the tester's own installed game, builds a bounded replacement pack and verifies the contents delivered by FS.

A 200cc mod may also be usable if its changes live in RomFS resources. Mods requiring a modified `main` executable belong to a separate CodeFS path, which has not yet been validated as a general loader in a game.

**[Mario Kart World tester instructions](docs/MKW-TESTER.md)** · **[Implementation and limits](docs/HOW-IT-WORKS.md)** · **[Give feedback](docs/TEST-REPORT.md)**

## Requirements

- Nintendo Switch 2 in an environment supported by the current ns2jb FS acquisition (tested on firmware 23.0.1), SmileBASIC demo and a regular microSD card.
- Your own installed copy of the game and a mod you have permission to use.
- A PC during initial ns2jb setup and preparation, Node.js, Python 3, Zig and the separate upstream components referenced in the tester guide. **The PC is not needed to keep serving the mod after a successful handoff.**
- A new qualified FS session per installation. Do not reuse ASLR addresses, journals or native object handles from prior sessions.

The current tester workflow has not been independently reproduced on another console. Stop on an unexpected qualification failure; never treat a failed native operation as a successful installation.

## Source and provenance

The `research/` directory is a focused extraction of the existing Switch 2 FS reader and MKWorld probe-pack tools from [Superstars-Mod-NS2](https://github.com/SebaaMG/Superstars-Mod-NS2). The acquisition comes from [Kurumuz's ns2jb](https://gitlab.com/kurumuz/ns2jb), building on pepsipu's work, with external [OunceCake](https://github.com/byizmysh/IZ2S-Platform) tooling. The resident reader and FS/RO handoff research are the additional implementation.

No Nintendo game files, decrypted firmware, keys, SDK dumps, mod assets or private console captures are included. Mods must be supplied separately by their owners. This snapshot does not establish a license for third-party assets or dependencies.

**This is a private test snapshot, not a public universal compatibility or safety guarantee.**
