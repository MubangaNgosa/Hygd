"""Make the app's top-level modules (app, database, parser…) importable from tests/."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
