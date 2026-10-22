"""Immutable uploaded bytes and explicit submitted-name associations per session."""
import hashlib
import json
from pathlib import Path
import re


MANIFEST_NAME = 'upload_manifest.json'


def _write_manifest(directory: Path, records: list[dict]) -> None:
    temporary = directory / '.upload_manifest.tmp'
    temporary.write_text(json.dumps({'version': 1, 'recordings': records}, ensure_ascii=False, indent=2))
    temporary.replace(directory / MANIFEST_NAME)


def save_recordings(uploads, directory: Path) -> dict[str, Path]:
    """Save every stream once. Generated working files use a different namespace.

    Record intent before copying so an interrupted duplicate upload cannot make
    another stream look like the unique file for a submitted reference.
    """
    if (directory / MANIFEST_NAME).exists():
        raise FileExistsError('Session recordings have already been registered')
    records = []; saved = {}
    _write_manifest(directory, records)
    for index, upload in enumerate(uploads):
        original = upload.filename
        basename = Path(original or 'audio').name
        basename = re.sub(r'[^A-Za-z0-9._-]', '_', basename)[:160] or 'audio'
        if Path(basename).suffix.lower() not in {'.wav', '.webm', '.m4a', '.mp3', '.ogg', '.flac', '.aac', '.caf'}:
            basename += {'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/webm': '.webm',
                         'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg'}.get(upload.content_type, '.bin')
        filename = f'recording-{index:04d}-{basename}'
        record = {'original_filename': original, 'stored_filename': filename,
                  'complete': False, 'sha256': None, 'size_bytes': None}
        records.append(record); _write_manifest(directory, records)
        target = directory / filename
        hasher = hashlib.sha256(); size = 0
        with target.open('xb') as stream:
            while chunk := upload.file.read(1024 * 1024):
                stream.write(chunk); hasher.update(chunk); size += len(chunk)
        record.update(complete=True, sha256=hasher.hexdigest(), size_bytes=size)
        _write_manifest(directory, records)
        saved[filename] = target
    return saved


def read_recordings(directory: Path) -> list[dict]:
    try:
        body = json.loads((directory / MANIFEST_NAME).read_text())
    except (OSError, ValueError):
        return []
    records = body.get('recordings') if isinstance(body, dict) else None
    return [r for r in records if isinstance(r, dict)] if isinstance(records, list) else []


def bind_recordings(items: list[dict], directory: Path) -> tuple[list[dict], bool]:
    """Resolve only exact, unique submitted references, never upload order."""
    records = read_recordings(directory)
    result = []; unresolved = False
    for item in items:
        reference = item.get('audioFilename')
        matches = [r for r in records if r.get('original_filename') == reference] if isinstance(reference, str) and reference else []
        resolved = ''
        status = 'ambiguous' if len(matches) > 1 else 'missing'
        if len(matches) == 1:
            record = matches[0]; name = record.get('stored_filename')
            if (record.get('complete') is True and isinstance(name, str) and name
                    and Path(name).name == name and (directory / name).is_file()):
                resolved = name; status = 'resolved'
        result.append({**item, 'audioFilename': resolved, 'audioAssociation': status})
        if status != 'resolved' and not str(item.get('id', '')).startswith('p-'):
            unresolved = True
    return result, unresolved


def analysis_recordings(items: list[dict], saved: dict[str, Path]) -> tuple[dict[str, Path], dict]:
    """Select uniquely bound non-profile audio in submitted answer order.

    Upload order is storage order, not conversational order or ownership.
    Repeated references include the file once; question text stays untouched.
    Orientation, reflection and free recall remain non-profile observations.
    """
    selected = {}; referenced = set(); counts = {}; unresolved = []
    for item in items:
        name = item.get('audioFilename')
        profile = str(item.get('id', '')).startswith('p-')
        resolved = (item.get('audioAssociation') == 'resolved'
                    and isinstance(name, str) and name in saved)
        if resolved:
            referenced.add(name)
            if not profile:
                selected.setdefault(name, saved[name])
                counts[name] = counts.get(name, 0) + 1
        elif not profile:
            unresolved.append(str(item.get('id', '')))
    return selected, {
        'scope': 'Uniquely bound non-profile answer recordings; one copy per file, in answer order.',
        'selected_filenames': list(selected),
        'profile_only_filenames': [name for name in saved if name in referenced and name not in selected],
        'unreferenced_filenames': [name for name in saved if name not in referenced],
        'unresolved_answer_ids': unresolved,
        'shared_analysis_filenames': [name for name, count in counts.items() if count > 1],
        'decode_assessed': False,
    }
