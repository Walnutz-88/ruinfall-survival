# Ruinfall Survival

A browser-based 3D zombie survival prototype: one ruined city, scavenging, base building, and a two-week survival goal.

## Features
- Procedural layout each run (seeded terrain and city placement).
- Single ruined city with roads, building shells, and enterable interiors (including a large mall concourse).
- Looting for food, water, ammo, medkits, and a rifle unlock.
- First-person combat (pistol and rifle), hunger, thirst, and zombie threats.
- Inventory panel and on-screen prompts for doors and loot.
- Heavier rendering path in-engine: ACES tone mapping, image-based lighting (`RoomEnvironment`), optional **Poly Haven HDRI** upgrade over the network, soft shadows, bloom, and PBR-style materials.
- **First-person weapon view-models** (pistol + rifle) with sway and recoil; optional **`public/models/rifle.glb`** replaces the procedural rifle in-hand.

## Controls
- `WASD`: move
- `Mouse`: look
- `Space`: jump
- `Shift`: sprint
- `Left click`: fire
- `B` / `R`: place / remove wall (outdoors)
- `E`: enter or exit building when prompt shows
- `F`: pick up nearby loot when prompt shows
- `1` / `2` / `3`: use food / water / medkit
- `Q`: swap weapon (after rifle is found)

## Higher fidelity assets
- **HDRI**: On first run with network access, the game tries to load a CC0 outdoor HDR from Poly Haven and use it as `scene.environment`. Offline play keeps the built-in studio probe.
- **Rifle model**: Drop a `rifle.glb` into `public/models/` (same rig works best if oriented along −Z). The first-person rifle view-model will swap to your mesh automatically.
- For full city geometry, add more glTF under `public/models/` and instance them in `buildCityRuins` / `createEnterableBuilding`.

## Run on MacBook Pro
1. `npm install`
2. `npm run dev`
3. `npm run build` for a production bundle in `dist/`.
