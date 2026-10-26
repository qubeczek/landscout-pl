#!/usr/bin/env python3
"""Rejestr priorytetów ofert (properties/priority_registry.json).

Wyższy priorytet = ważniejsza oferta (pokazywana wyżej na liście).

Formuła automatyczna: STATUS_BASE[status] + score * 100
  inactive  → 100 000 + score*100  (100 000–110 000)
  active    → 200 000 + score*100  (200 000–210 000)
  watch     → 300 000 + score*100  (300 000–310 000)
  favorite  → 400 000 + score*100  (400 000–410 000)

Przerwy między grupami statusu (~90 000 pkt) zostawiają miejsce na drag & drop
między grupami. Ręczna zmiana przez drag & drop ustala wartość jako midpoint sąsiadów.

Użycie:
  get         --id ID
  set         --id ID --priority P [--manual]
  recompute   --id ID [--force]
  recompute-all [--force]
  list
  normalize   [--force]
"""

import json
import re
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = _ROOT / "properties" / "priority_registry.json"
LISTINGS_DIR = _ROOT / "properties" / "listings"
ID_RE = re.compile(r"^\d{8}_\d{3,}$")

STATUS_BASE = {
    "favorite": 400_000,
    "watch":    300_000,
    "active":   200_000,
    "inactive": 100_000,
}

NORMALIZE_THRESHOLD = 0.01  # jeśli min gap < tego → normalize potrzebne


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text("utf-8"))
    return {}


def save_registry(registry: dict) -> None:
    REGISTRY_PATH.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False) + "\n",
        "utf-8",
    )


def auto_priority(status: str, score) -> float:
    base = STATUS_BASE.get(str(status or "inactive"), 100_000)
    return float(base + (int(score) if score is not None else 0) * 100)


def _read_fields(listing_id: str):
    """Czyta status i score z frontmattera .md; None gdy plik nie istnieje."""
    path = LISTINGS_DIR / f"{listing_id}.md"
    if not path.exists():
        return None
    content = path.read_text("utf-8")
    if not content.startswith("---"):
        return None
    parts = content.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        if yaml:
            fm = yaml.safe_load(parts[1]) or {}
        else:
            fm = {}
            for line in parts[1].splitlines():
                if ":" in line and not line.startswith(" ") and not line.startswith("-"):
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip("'\"")
    except Exception:
        return None
    return {
        "status": str(fm.get("status") or "active"),
        "score": fm.get("score"),
    }


def _recompute_one(registry: dict, listing_id: str, force: bool = False) -> bool:
    """Przelicza priorytet jednej oferty. Zwraca True gdy wpis się zmienił."""
    entry = registry.get(listing_id, {})
    if entry.get("manual") and not force:
        return False
    fields = _read_fields(listing_id)
    if fields is None:
        return False
    priority = auto_priority(fields["status"], fields["score"])
    registry[listing_id] = {
        "priority": priority,
        "manual": False,
        "updated_at": _now(),
    }
    return True


# --- komendy CLI ---

def cmd_get(args):
    registry = load_registry()
    entry = registry.get(args.id)
    if not entry:
        fields = _read_fields(args.id)
        if fields:
            entry = {
                "priority": auto_priority(fields["status"], fields["score"]),
                "manual": False,
            }
        else:
            entry = {}
    print(json.dumps(entry))


def cmd_set(args):
    registry = load_registry()
    entry = registry.get(args.id, {})
    entry["priority"] = float(args.priority)
    entry["manual"] = args.manual
    entry["updated_at"] = _now()
    registry[args.id] = entry
    save_registry(registry)
    print(json.dumps(entry))


def cmd_recompute(args):
    registry = load_registry()
    changed = _recompute_one(registry, args.id, force=args.force)
    if changed:
        save_registry(registry)
    entry = registry.get(args.id, {})
    print(json.dumps({"ok": True, "changed": changed, **entry}))


def cmd_recompute_all(args):
    registry = load_registry()
    changed = 0
    existing = set()
    for path in sorted(LISTINGS_DIR.glob("*.md")):
        lid = path.stem
        if ID_RE.match(lid):
            existing.add(lid)
            if _recompute_one(registry, lid, force=args.force):
                changed += 1
    # usuń wpisy osierocone (oferta skasowana / przeniesiona do deleted/)
    stale = [lid for lid in list(registry) if lid not in existing]
    for lid in stale:
        del registry[lid]
    save_registry(registry)
    print(json.dumps({"ok": True, "recomputed": changed, "total": len(registry), "removed": len(stale)}))


def cmd_list(args):
    registry = load_registry()
    items = sorted(registry.items(), key=lambda x: x[1].get("priority", 0), reverse=True)
    print(json.dumps([{"id": lid, **data} for lid, data in items]))


def cmd_normalize(args):
    """Rozstrzelenie priorytetów gdy gap jest za mały (fractional indexing maintenance).

    Zachowuje kolejność i grupowanie wg statusu. Relatywna kolejność jest zachowana,
    absolutna wartość zostaje dopasowana do przedziału grupy.
    """
    registry = load_registry()
    if not registry:
        print(json.dumps({"ok": True, "normalized": 0}))
        return

    items_sorted = sorted(registry.items(), key=lambda x: x[1].get("priority", 0), reverse=True)
    priorities = [v["priority"] for _, v in items_sorted]

    if len(priorities) > 1:
        min_gap = min(abs(priorities[i] - priorities[i + 1]) for i in range(len(priorities) - 1))
    else:
        min_gap = float("inf")

    if min_gap >= NORMALIZE_THRESHOLD and not args.force:
        print(json.dumps({"ok": True, "normalized": 0, "min_gap": min_gap}))
        return

    # Pogrupuj wg statusu zachowując kolejność wewnątrz grupy
    groups: dict = {s: [] for s in STATUS_BASE}
    for lid, _ in items_sorted:
        fields = _read_fields(lid)
        status = fields["status"] if fields else "inactive"
        target = groups.get(status, groups["inactive"])
        target.append(lid)

    normalized = 0
    for status, ids in groups.items():
        n = len(ids)
        if not n:
            continue
        base = STATUS_BASE[status]
        step = 9_000.0 / max(n, 1)
        for i, lid in enumerate(ids):
            new_p = base + 9_000.0 - i * step
            old_p = registry[lid].get("priority", 0)
            if abs(old_p - new_p) > 1e-9:
                registry[lid]["priority"] = new_p
                registry[lid]["updated_at"] = _now()
                normalized += 1

    save_registry(registry)
    print(json.dumps({"ok": True, "normalized": normalized, "min_gap": min_gap}))


def main():
    parser = argparse.ArgumentParser(description="Rejestr priorytetów ofert")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("get", help="Pobierz priorytet oferty")
    p.add_argument("--id", required=True)

    p = sub.add_parser("set", help="Ustaw priorytet ręcznie (drag & drop)")
    p.add_argument("--id", required=True)
    p.add_argument("--priority", type=float, required=True)
    p.add_argument("--manual", action="store_true", default=False,
                   help="Oznacz jako ręcznie ustawiony (użyj przy drag & drop)")

    p = sub.add_parser("recompute", help="Przelicz priorytet oferty")
    p.add_argument("--id", required=True)
    p.add_argument("--force", action="store_true",
                   help="Przelicz nawet gdy priorytet był ręczny (używaj przy zmianie statusu)")

    p = sub.add_parser("recompute-all", help="Przelicz priorytety wszystkich ofert")
    p.add_argument("--force", action="store_true")

    sub.add_parser("list", help="Lista priorytetów (JSON, malejąco)")

    p = sub.add_parser("normalize", help="Rozstrzel priorytety gdy gap < progu")
    p.add_argument("--force", action="store_true")

    args = parser.parse_args()
    dispatch = {
        "get": cmd_get,
        "set": cmd_set,
        "recompute": cmd_recompute,
        "recompute-all": cmd_recompute_all,
        "list": cmd_list,
        "normalize": cmd_normalize,
    }
    dispatch[args.cmd](args)


if __name__ == "__main__":
    main()
