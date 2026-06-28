#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


NBSP = "\xa0"
NUMBERED_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+(.+)$")
SPAN_ONLY_RE = re.compile(r'^\s*<span id="[^"]+">(.*?)</span>\s*$')
EMPTY_ANCHOR_RE = re.compile(r'<span id="[^"]+"></span>')
SPAN_TAG_RE = re.compile(r"</?span\b[^>]*>")
DIV_TAG_RE = re.compile(r"</?div\b[^>]*>")
BR_TAG_RE = re.compile(r"<br\b[^>]*/?>")
BACK_TO_TOP_RE = re.compile(r'\s*\[<img[^]]+>\]\(#HautDePage\)\s*$', re.IGNORECASE)
BULLET_SPAN_RE = re.compile(r'^<span style="font-family:Symbol">·<span style="font:[^"]+"> </span></span>\s*')
HTML_TAG_ONLY_RE = re.compile(r"^\s*<[^>]+>\s*$")
MULTI_BLANK_RE = re.compile(r"\n{3,}")
UPDATED_AT_RE = re.compile(r"ANSM\s*-\s*Mis a jour le\s*:\s*(.+)$", re.IGNORECASE)
INTERNAL_LINK_RE = re.compile(r"\[([^\]]+)\]\(#[^)]+\)")

SUP_RE = re.compile(r"<sup>(.*?)</sup>", re.IGNORECASE)
SUB_RE = re.compile(r"<sub>(.*?)</sub>", re.IGNORECASE)

TD_CONTENT_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.IGNORECASE | re.DOTALL)
TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
TABLE_BLOCK_RE = re.compile(
    r"<table[^>]*>.*?</table>", re.IGNORECASE | re.DOTALL
)
P_TAG_RE = re.compile(r"</?p\b[^>]*>", re.IGNORECASE)
ANY_HTML_TAG_RE = re.compile(r"<[^>]+>")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convertit les RCP HTML extraits en Markdown exploitable par un LLM."
    )
    parser.add_argument(
        "--input-dir",
        default="rcp",
        help="Repertoire contenant les fichiers HTML source (par defaut: rcp).",
    )
    parser.add_argument(
        "--output-dir",
        default="rcp_md",
        help="Repertoire de sortie Markdown (par defaut: rcp_md).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(8, (os.cpu_count() or 4)),
        help="Nombre de conversions en parallele (par defaut: min(8, cpu_count)).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerer les fichiers meme s'ils existent deja.",
    )
    return parser.parse_args()


def run_pandoc(html_path: Path) -> str:
    result = subprocess.run(
        [
            "pandoc",
            "--from=html",
            "--to=gfm",
            "--wrap=none",
            str(html_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def strip_inline_html(text: str) -> str:
    text = EMPTY_ANCHOR_RE.sub("", text)
    text = SPAN_TAG_RE.sub("", text)
    text = DIV_TAG_RE.sub("", text)
    text = BR_TAG_RE.sub("  ", text)
    return html.unescape(text).strip()


def cell_text(cell_html: str) -> str:
    """Extrait le texte pur d'une cellule de tableau HTML."""
    text = P_TAG_RE.sub("", cell_html)
    text = SUP_RE.sub(r"\1", text)
    text = SUB_RE.sub(r"\1", text)
    text = SPAN_TAG_RE.sub("", text)
    text = ANY_HTML_TAG_RE.sub("", text)
    text = html.unescape(text).replace(NBSP, " ")
    return re.sub(r"\s+", " ", text).strip()


def html_table_to_markdown(table_html: str) -> str:
    """Convertit un bloc <table>...</table> HTML en pipe-table Markdown."""
    rows: list[list[str]] = []
    for tr_match in TR_RE.finditer(table_html):
        tr_content = tr_match.group(1)
        cells = [cell_text(m.group(1)) for m in TD_CONTENT_RE.finditer(tr_content)]
        if not cells:
            # Chercher aussi les <th>
            th_re = re.compile(r"<th[^>]*>(.*?)</th>", re.IGNORECASE | re.DOTALL)
            cells = [cell_text(m.group(1)) for m in th_re.finditer(tr_content)]
        if cells:
            rows.append(cells)

    if not rows:
        return ""

    ncols = max(len(r) for r in rows)
    for row in rows:
        while len(row) < ncols:
            row.append("")

    col_widths = [max(len(row[c]) for row in rows) for c in range(ncols)]
    col_widths = [max(w, 3) for w in col_widths]

    lines: list[str] = []
    for i, row in enumerate(rows):
        padded = [row[c].ljust(col_widths[c]) for c in range(ncols)]
        lines.append("| " + " | ".join(padded) + " |")
        if i == 0:
            lines.append("| " + " | ".join("-" * w for w in col_widths) + " |")

    return "\n".join(lines)


def convert_residual_tables(text: str) -> str:
    """Remplace les blocs <table>...</table> résiduels par des pipe-tables."""
    def replacer(match: re.Match) -> str:
        md_table = html_table_to_markdown(match.group(0))
        return md_table if md_table else ""

    return TABLE_BLOCK_RE.sub(replacer, text)


def convert_inline_table_rows(text: str) -> str:
    """Traite les lignes <td>...</td> orphelines (hors <table>) restées après pandoc."""
    result_lines: list[str] = []
    in_row: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("<td") or stripped.startswith("<th"):
            content = cell_text(stripped)
            if content:
                in_row.append(content)
        elif stripped in ("</tr>", "<tr>", "<tr >") or re.match(r"<tr\s", stripped):
            if in_row:
                result_lines.append("| " + " | ".join(in_row) + " |")
                in_row = []
        elif stripped in ("</table>", "</thead>", "</tbody>", "<thead>", "<tbody>"):
            if in_row:
                result_lines.append("| " + " | ".join(in_row) + " |")
                in_row = []
        else:
            if in_row:
                result_lines.append("| " + " | ".join(in_row) + " |")
                in_row = []
            result_lines.append(line)

    if in_row:
        result_lines.append("| " + " | ".join(in_row) + " |")

    return "\n".join(result_lines)


def normalize_heading(line: str) -> str | None:
    match = SPAN_ONLY_RE.match(line)
    if not match:
        return None

    text = strip_inline_html(match.group(1))
    if not text:
        return None

    numbered = NUMBERED_HEADING_RE.match(text)
    if numbered:
        depth = min(3, len(numbered.group(1).split(".")))
        return f'{"#" * depth} {text}'

    if len(text) <= 80 and not text.endswith("."):
        return f"### {text}"

    return text


def clean_markdown(markdown: str) -> tuple[str, str | None, str | None]:
    markdown = convert_residual_tables(markdown)
    markdown = convert_inline_table_rows(markdown)

    cleaned_lines: list[str] = []

    for raw_line in markdown.splitlines():
        line = raw_line.replace(NBSP, " ").strip()
        if not line:
            cleaned_lines.append("")
            continue

        if line in {"<div id=\"textDocument\">", "</div>"}:
            continue

        line = BACK_TO_TOP_RE.sub("", line)
        if "Retour en haut de la page" in line and "BackToTop.jpg" in line:
            continue

        heading = normalize_heading(line)
        if heading is not None:
            cleaned_lines.append(heading)
            continue

        if "<span style=\"font-size:" in line or "text-transform:" in line or line == "uppercase\">":
            continue

        line = BULLET_SPAN_RE.sub("- ", line)

        line = SUP_RE.sub(r"\1", line)
        line = SUB_RE.sub(r"\1", line)

        line = strip_inline_html(line)
        line = INTERNAL_LINK_RE.sub(r"\1", line)
        line = line.replace("\\[", "[").replace("\\]", "]")

        if re.match(r"^\s*·\s*", line):
            line = re.sub(r"^\s*·\s*", "- ", line)
        line = line.replace(" · ", " - ")

        line = P_TAG_RE.sub("", line).strip()

        if not line or HTML_TAG_ONLY_RE.match(line):
            continue

        cleaned_lines.append(line)

    text = "\n".join(cleaned_lines).strip()
    text = MULTI_BLANK_RE.sub("\n\n", text)

    lines = [line for line in text.splitlines() if line.strip()]
    updated_at = None
    title = None

    for idx, line in enumerate(lines):
        normalized = (
            line.replace("à", "a")
            .replace("À", "A")
            .replace("é", "e")
            .replace("è", "e")
        )
        updated_match = UPDATED_AT_RE.match(normalized)
        if updated_match:
            updated_at = updated_match.group(1).strip()
            continue

        if line == "# 1. DENOMINATION DU MEDICAMENT" and idx + 1 < len(lines):
            title = lines[idx + 1].strip()
            break

    if lines and updated_at and lines[0].startswith("ANSM - Mis"):
        text = "\n".join(text.splitlines()[1:]).lstrip()

    return text, title, updated_at


def yaml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_document(cis: str, source_path: Path, body: str, title: str | None, updated_at: str | None) -> str:
    front_matter = [
        "---",
        f'cis: "{yaml_escape(cis)}"',
        'document_type: "RCP"',
        f'source_html: "{yaml_escape(str(source_path))}"',
    ]

    if title:
        front_matter.append(f'title: "{yaml_escape(title)}"')
    if updated_at:
        front_matter.append(f'updated_at: "{yaml_escape(updated_at)}"')

    front_matter.append("---")
    front_matter.append("")
    return "\n".join(front_matter) + body + "\n"


def convert_one_file(html_path: Path, output_dir: Path, force: bool) -> str:
    cis = html_path.stem
    output_path = output_dir / f"{cis}.md"

    if output_path.exists() and not force:
        return f"skip:{cis}"

    raw_markdown = run_pandoc(html_path)
    cleaned_body, title, updated_at = clean_markdown(raw_markdown)
    document = build_document(cis, html_path, cleaned_body, title, updated_at)
    output_path.write_text(document, encoding="utf-8")
    return f"ok:{cis}"


def main() -> int:
    args = parse_args()

    if shutil.which("pandoc") is None:
        raise RuntimeError("pandoc est introuvable dans le PATH.")

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)

    if not input_dir.exists():
        raise FileNotFoundError(f"Repertoire introuvable: {input_dir}")

    html_files = sorted(input_dir.glob("*.html"))
    if not html_files:
        raise FileNotFoundError(f"Aucun fichier HTML trouve dans {input_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)

    converted = 0
    skipped = 0

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(convert_one_file, html_path, output_dir, args.force): html_path
            for html_path in html_files
        }

        for future in as_completed(futures):
            result = future.result()
            if result.startswith("ok:"):
                converted += 1
            elif result.startswith("skip:"):
                skipped += 1

    print(
        f"Conversion terminee: {converted} fichiers convertis, {skipped} ignores, sortie={output_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
