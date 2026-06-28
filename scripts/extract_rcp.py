#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path


csv.field_size_limit(10**9)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extrait les documents RCP depuis CIS_RCP.csv vers un dossier rcp."
    )
    parser.add_argument(
        "--input",
        default="CIS_RCP.csv",
        help="Chemin du fichier source (par defaut: CIS_RCP.csv).",
    )
    parser.add_argument(
        "--output-dir",
        default="rcp",
        help="Repertoire de sortie (par defaut: rcp).",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Encodage du fichier source (par defaut: utf-8).",
    )
    return parser.parse_args()


def extract_documents(input_path: Path, output_dir: Path, encoding: str) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)

    extracted = 0
    with input_path.open("r", encoding=encoding, newline="") as source:
        reader = csv.DictReader(source, delimiter="\t")

        if not reader.fieldnames:
            raise ValueError("Aucune entete detectee dans le fichier source.")

        expected_columns = {"Code_CIS", "RCP_html"}
        missing_columns = expected_columns.difference(reader.fieldnames)
        if missing_columns:
            missing = ", ".join(sorted(missing_columns))
            raise ValueError(f"Colonnes manquantes: {missing}")

        for row in reader:
            cis = (row.get("Code_CIS") or "").strip()
            html = row.get("RCP_html") or ""

            if not cis or not html:
                continue

            output_path = output_dir / f"{cis}.html"
            output_path.write_text(html, encoding="utf-8")
            extracted += 1

    return extracted


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output_dir)

    if not input_path.exists():
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    extracted = extract_documents(input_path, output_dir, args.encoding)
    print(f"{extracted} documents extraits dans {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
