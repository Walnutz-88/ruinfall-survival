# Ruinfall Survival

A browser-based 3D zombie survival prototype: one ruined city, scavenging, base building, and a two-week survival goal.

## Features
- Procedural layout each run (seeded terrain and city placement).
- Single ruined city with roads, building shells, and enterable interiors (including a large mall concourse).
- Looting for food, water, ammo, medkits, and a rifle unlock.
- First-person combat (pistol and rifle), hunger, thirst, and zombie threats.
- Inventory panel and on-screen prompts for doors and loot.
- Heavier rendering path in-engine: ACES tone mapping, image-based lighting (`RoomEnvironment`), soft shadows, bloom, and PBR-style materials (procedural textures; swap in glTF assets for film-grade detail).

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
This repo uses procedural textures so it runs with zero downloads. For photoreal guns and architecture, add glTF/GLB models under `public/models/` and load them with `GLTFLoader` (see Three.js docs). HDR outdoor probes can replace `RoomEnvironment` via `RGBELoader` for even more realistic lighting.

## Run on MacBook Pro
1. `npm install`
2. `npm run dev`
3. `npm run build` for a production bundle in `dist/`.
