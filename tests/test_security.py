"""Upload filenames, error messages and response headers can't be used against the server.

Run:  python -m pytest tests
"""
import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "events.db"))
    import app as app_module
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setitem(app_module.app.config, "UPLOAD_FOLDER", str(uploads))
    monkeypatch.setattr(app_module, "extract_and_parse_pdf", lambda path, name: [])
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        c.uploads = uploads
        c.app_module = app_module
        yield c


def _upload(client, name, data=b"%PDF-1.7 test"):
    return client.post("/upload", data={"file": (io.BytesIO(data), name)},
                       content_type="multipart/form-data")


def test_upload_name_cannot_escape_the_uploads_folder(client, tmp_path):
    r = _upload(client, "../../evil.pdf")
    assert r.status_code == 200
    saved = list(client.uploads.iterdir())
    assert len(saved) == 1 and saved[0].name.endswith("-evil.pdf")
    assert not (tmp_path / "evil.pdf").exists()


def test_same_name_twice_keeps_both_files(client):
    _upload(client, "Daily Events.pdf")
    _upload(client, "Daily Events.pdf")
    assert len(list(client.uploads.iterdir())) == 2


def test_non_pdf_content_is_rejected(client):
    r = _upload(client, "notes.pdf", data=b"<html>not a pdf</html>")
    assert r.status_code == 400
    assert not list(client.uploads.iterdir())


def test_parse_errors_dont_leak_details(client, monkeypatch):
    def boom(path, name):
        raise RuntimeError("secret internal path C:\\server\\thing")
    monkeypatch.setattr(client.app_module, "extract_and_parse_pdf", boom)
    r = _upload(client, "Daily Events.pdf")
    assert r.status_code == 500
    assert "secret" not in r.get_data(as_text=True)


def test_note_images_get_random_names(client, monkeypatch, tmp_path):
    monkeypatch.setattr(client.app_module, "NOTE_IMAGE_DIR", str(tmp_path))
    from werkzeug.datastructures import FileStorage
    f = FileStorage(io.BytesIO(b"img"), filename="../../evil.png")
    [name] = client.app_module._save_note_images([f])
    assert name.endswith(".png") and "/" not in name and "evil" not in name
    assert (tmp_path / name).exists()


@pytest.mark.parametrize("url", ["/", "/analytics", "/comments/report", "/api/stats",
                                 "/note-images/missing.png"])
def test_every_response_has_security_headers(client, url):
    r = client.get(url)
    csp = r.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "same-origin"


def test_event_data_is_not_cached_but_pages_are_unchanged(client):
    assert client.get("/api/stats").headers["Cache-Control"] == "no-store"
    assert client.get("/comments/report").headers["Cache-Control"] == "no-store"
    assert client.get("/comments/report?format=csv").headers["Cache-Control"] == "no-store"
    assert "no-store" not in client.get("/").headers.get("Cache-Control", "")
