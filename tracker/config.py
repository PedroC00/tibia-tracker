"""Configuration: public template + private overrides.

config.yaml is a public example. Real settings come from, in order:
  1. config.local.yaml (git-ignored, for local runs)
  2. the TRACKER_CONFIG environment variable (a GitHub secret in Actions)
Each top-level section present in an override replaces the template's section entirely.
"""
from __future__ import annotations

import os
from pathlib import Path

import yaml


def load_config(template: Path) -> dict:
    cfg = yaml.safe_load(template.read_text()) or {}
    local = template.with_name("config.local.yaml")
    overrides = [local.read_text()] if local.exists() else []
    if os.environ.get("TRACKER_CONFIG", "").strip():
        overrides.append(os.environ["TRACKER_CONFIG"])
    for text in overrides:
        cfg.update(yaml.safe_load(text) or {})
    return cfg
