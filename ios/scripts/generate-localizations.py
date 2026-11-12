#!/usr/bin/env python3
"""Generate native iOS string tables from the app's Lingui catalogs."""

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[2]
IOS_SOURCE = ROOT / "ios" / "Thunderbolt"
OVERRIDES = (
    IOS_SOURCE / "Localization" / "native-overrides.json",
    IOS_SOURCE / "Localization" / "native-security-overrides.json",
    IOS_SOURCE / "Localization" / "native-ui-overrides.json",
)
LOCALES = ("de", "es", "fr", "ja", "pt-BR")
STRINGS_ENTRY = re.compile(r'^"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)";$')
PO_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
FORMAT_PLACEHOLDER = re.compile(r"%(?:[0-9]+\$)?@")


def unquote_po(value: str) -> str:
    """Decode a quoted PO string using JSON-compatible escapes."""
    return json.loads(value)


def parse_po(path: Path) -> dict[str, str]:
    """Read singular PO message ids and translations without external packages."""
    messages: dict[str, str] = {}
    message_id: Optional[str] = None
    translation = ""
    active_field: Optional[str] = None

    def finish() -> None:
        if message_id and translation:
            messages[message_id] = translation

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("msgid "):
            finish()
            message_id = unquote_po(line[len("msgid "):])
            translation = ""
            active_field = "id"
        elif line.startswith("msgstr "):
            translation = unquote_po(line[len("msgstr "):])
            active_field = "translation"
        elif line.startswith("msgstr[0] "):
            translation = unquote_po(line[len("msgstr[0] "):])
            active_field = "translation"
        elif line.startswith('"') and active_field:
            value = unquote_po(line)
            if active_field == "id":
                message_id = (message_id or "") + value
            elif active_field == "translation":
                translation += value
        elif line.startswith("msgctxt ") or line.startswith("msgid_plural ") or line.startswith("msgstr["):
            active_field = None
    finish()
    return messages


def xcode_localization_keys() -> set[str]:
    """Use Xcode's extractor to honor SwiftUI literals and compiler format placeholders."""
    extractor = shutil.which("xcrun")
    if not extractor:
        raise RuntimeError("xcrun is required to extract native Swift localizations.")

    sources = sorted(IOS_SOURCE.rglob("*.swift"))
    with tempfile.TemporaryDirectory(prefix="thunderbolt-ios-l10n-") as temporary:
        temporary_root = Path(temporary)
        source_root = temporary_root / "source"
        output_root = temporary_root / "extracted"
        output_root.mkdir()
        copied_sources = []
        for source in sources:
            copy = source_root / source.relative_to(IOS_SOURCE)
            copy.parent.mkdir(parents=True, exist_ok=True)
            contents = source.read_text(encoding="utf-8").replace("nativeString(", "Text(")
            copy.write_text(contents, encoding="utf-8")
            copied_sources.append(str(copy))

        result = subprocess.run(
            [extractor, "extractLocStrings", "-SwiftUI", "-u", "-o", str(output_root), *copied_sources],
            check=False,
            capture_output=True,
            text=True,
        )
        strings_file = output_root / "Localizable.strings"
        if not strings_file.exists():
            raise RuntimeError(f"Xcode localization extraction failed: {result.stderr or result.stdout}")
        for diagnostic in (result.stderr or "").splitlines():
            if "error:" in diagnostic:
                print(f"Xcode extractor skipped a non-literal localization call: {diagnostic}")

        keys = set()
        for line in strings_file.read_text(encoding="utf-16").splitlines():
            match = STRINGS_ENTRY.match(line.strip())
            if match:
                keys.add(unquote_po('"' + match.group(1) + '"'))
        return keys


def normalize_placeholders(value: str) -> str:
    """Normalize Lingui named placeholders and Xcode format tokens for matching."""
    return PO_PLACEHOLDER.sub("{}", FORMAT_PLACEHOLDER.sub("{}", value))


def formatted_translation(key: str, english_id: str, translation: str) -> Optional[str]:
    """Map a matching Lingui interpolation to the positional format expected by .strings."""
    source_names = PO_PLACEHOLDER.findall(english_id)
    key_count = len(FORMAT_PLACEHOLDER.findall(key))
    translated_names = PO_PLACEHOLDER.findall(translation)
    if not source_names or len(source_names) != key_count or len(translated_names) != key_count:
        return None

    position = {name: index + 1 for index, name in enumerate(source_names)}

    def replace(match: re.Match[str]) -> str:
        index = position.get(match.group(1))
        if index is None:
            return match.group(0)
        return "%@" if key_count == 1 else f"%{index}$@"

    formatted = PO_PLACEHOLDER.sub(replace, translation)
    if PO_PLACEHOLDER.search(formatted):
        return None
    return formatted


def translated_strings(messages: dict[str, str], keys: set[str]) -> tuple[dict[str, str], int]:
    """Match literal keys first, then match interpolated keys by placeholder shape."""
    normalized: dict[str, list[tuple[str, str]]] = {}
    casefolded: dict[str, list[tuple[str, str]]] = {}
    for english_id, translation in messages.items():
        normalized.setdefault(normalize_placeholders(english_id), []).append((english_id, translation))
        if not FORMAT_PLACEHOLDER.search(english_id) and not PO_PLACEHOLDER.search(english_id):
            casefolded.setdefault(english_id.casefold().strip(), []).append((english_id, translation))

    output: dict[str, str] = {}
    formatted_count = 0
    for key in keys:
        if messages.get(key):
            output[key] = messages[key]
            continue
        canonical = casefolded.get(key.casefold().strip(), [])
        if not FORMAT_PLACEHOLDER.search(key) and len(canonical) == 1:
            output[key] = canonical[0][1]
            continue
        candidates = normalized.get(normalize_placeholders(key), [])
        if len(candidates) != 1:
            continue
        english_id, translation = candidates[0]
        if FORMAT_PLACEHOLDER.search(key):
            value = formatted_translation(key, english_id, translation)
            if value:
                output[key] = value
                formatted_count += 1
    return output, formatted_count


def render_strings(messages: dict[str, str]) -> str:
    """Render a sorted Apple .strings table for translated native literals."""
    lines = ["/* Generated from the app's Lingui catalogs by ios/scripts/generate-localizations.py. */"]
    for key in sorted(messages):
        lines.append(f"{json.dumps(key, ensure_ascii=False)} = {json.dumps(messages[key], ensure_ascii=False)};")
    return "\n".join(lines) + "\n"


def main() -> None:
    keys = xcode_localization_keys()
    format_keys = {key for key in keys if FORMAT_PLACEHOLDER.search(key)}
    print(f"Found {len(keys)} distinct native localization keys ({len(format_keys)} with interpolation).")
    english = {key: key for key in keys}
    english_output = IOS_SOURCE / "en.lproj" / "Localizable.strings"
    english_output.parent.mkdir(parents=True, exist_ok=True)
    english_output.write_text(render_strings(english), encoding="utf-8")
    subprocess.run(["plutil", "-lint", str(english_output)], check=True, stdout=subprocess.DEVNULL)
    for locale in LOCALES:
        translations = parse_po(ROOT / "src" / "locales" / locale / "messages.po")
        localized, formatted_count = translated_strings(translations, keys)
        catalog_count = len(localized)
        overrides = {}
        for override_file in OVERRIDES:
            overrides.update(json.loads(override_file.read_text(encoding="utf-8")).get(locale, {}))
        override_count = 0
        for key, value in overrides.items():
            if key in keys and key not in localized:
                localized[key] = value
                override_count += 1
        output = IOS_SOURCE / f"{locale}.lproj" / "Localizable.strings"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render_strings(localized), encoding="utf-8")
        subprocess.run(["plutil", "-lint", str(output)], check=True, stdout=subprocess.DEVNULL)
        missing = len(keys) - len(localized)
        print(
            f"{locale}: catalog {catalog_count} ({catalog_count - formatted_count} static, "
            f"{formatted_count}/{len(format_keys)} formatted), manual {override_count}; "
            f"{missing} untranslated keys remain in English fallback."
        )


if __name__ == "__main__":
    main()
