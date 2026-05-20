"""
Smart layout planner.
- Логика расстановки: ворота перед замком, замок в центре, башни по углам
- Яхта/корабль: игрок появляется НА объекте, не на воде
- Деревья не ставятся рядом с замком (≥ 40м от центра)
- Генерирует 2D-карту расположения
"""

import math


def detect_role(name: str) -> str:
    n = name.lower()
    # Проверяем от наиболее специфичного к общему
    if "main_keep" in n or ("keep" in n and "tower" not in n):
        return "keep"
    if any(x in n for x in ["citadel", "palace", "fortress", "donjon", "castle_main"]):
        return "keep"
    if any(x in n for x in ["gate", "gatehouse", "entrance", "portal", "drawbridge"]):
        return "gate"
    if any(x in n for x in ["archway", "bridge", "path_arch"]):
        return "path"
    if any(x in n for x in ["watchtower", "turret", "minaret", "spire", "chapel"]):
        return "tower"
    if "tower" in n and any(x in n for x in ["corner", "guard", "watch", "battle"]):
        return "tower"
    if any(x in n for x in ["wall", "fortified", "rampart", "battlement", "parapet"]):
        return "wall"
    if any(x in n for x in ["yacht", "ship", "boat", "vessel", "galleon"]):
        return "vessel"
    if any(x in n for x in ["dock", "pier", "harbor", "port", "jetty"]):
        return "dock"
    if any(x in n for x in ["fountain", "well", "altar", "statue", "obelisk", "shrine", "pillar"]):
        return "deco"
    if any(x in n for x in ["tower", "turret"]):
        return "tower"
    if any(x in n for x in ["castle", "main"]):
        return "keep"
    return "deco"


# Позиции (world units) для каждой роли — несколько слотов
ROLE_POSITIONS = {
    "keep":   [(0, 0)],
    "gate":   [(0, 40), (0, -40)],
    "path":   [(0, 20), (-15, 20)],
    "tower":  [(-35, -25), (35, -25), (-35, 25), (35, 25)],
    "wall":   [(-48, 0), (48, 0), (0, -48)],
    "vessel": [(0, 0)],          # яхта в центре (игрок на ней)
    "dock":   [(0, 30), (-20, 20)],
    "deco":   [(15, 12), (-15, 12), (12, -12), (-12, -12), (0, -22), (22, -18)],
}


def fix_layout(scene: dict) -> dict:
    biome = scene.get("environment", {}).get("biome", "dark_forest")
    is_ocean = biome == "ocean"

    role_counters = {r: 0 for r in ROLE_POSITIONS}

    for building in scene.get("buildings", []):
        modules   = building.get("exterior_modules", [])
        grid_objs = building.get("layout_grid", {}).get("objects", [])
        grid_index = {g["name"]: g for g in grid_objs}

        for mod in modules:
            name = mod["name"]
            role = detect_role(name)
            slots = ROLE_POSITIONS.get(role, ROLE_POSITIONS["deco"])
            idx   = role_counters[role] % len(slots)
            wx, wz = slots[idx]
            role_counters[role] += 1

            if name in grid_index:
                grid_index[name].update({
                    "grid_x": wx,
                    "grid_z": wz,
                    "y_offset": 0,
                    "rotation_y": _rotation_for_role(role, wx, wz),
                })
            else:
                grid_objs.append({
                    "name": name,
                    "grid_x": wx,
                    "grid_z": wz,
                    "rotation_y": _rotation_for_role(role, wx, wz),
                    "y_offset": 0,
                })

        building["layout_grid"]["cell_size"] = 1
        building["layout_grid"]["objects"]   = list(grid_index.values())

    # Спавн игрока
    if is_ocean:
        # Яхта в центре — игрок появляется на ней (y чуть выше)
        scene["player_spawn"] = {
            "location": "vessel",
            "position": [0, 4.0, 0],   # на палубе яхты
        }
    else:
        # Перед воротами
        scene["player_spawn"] = {
            "location": "exterior",
            "position": [0, 1.0, 72],
        }

    # Запрет деревьев близко к центру
    if "landscape" in scene:
        _adjust_vegetation_clearance(scene["landscape"], min_dist=55)

    if "nature_archetypes" in scene:
        for arch in scene["nature_archetypes"]:
            if "distribute" in arch:
                arch["distribute"]["min_dist"] = max(
                    arch["distribute"].get("min_dist", 55), 55
                )
                # Для воды — не сажаем деревья в центре
                if is_ocean:
                    arch["distribute"]["min_dist"] = max(
                        arch["distribute"]["min_dist"], 80
                    )

    return scene


def _adjust_vegetation_clearance(landscape: dict, min_dist: int = 55):
    for veg in landscape.get("vegetation", []):
        veg["min_dist"] = max(veg.get("min_dist", min_dist), min_dist)
    if "rocks" in landscape:
        landscape["rocks"]["min_dist"] = max(
            landscape["rocks"].get("min_dist", 25), 25
        )


def _rotation_for_role(role: str, x: float, z: float) -> float:
    if role == "gate":
        return 0 if z > 0 else 180
    if role == "vessel":
        return 0
    if role in ("tower", "wall"):
        return math.degrees(math.atan2(x, z)) + 180
    return 0
