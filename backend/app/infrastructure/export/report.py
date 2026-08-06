"""Case-export rendering (Story 7.2, FR-7.2): CSV streaming + PDF report building.

Lives under infrastructure/ alongside ml/compensation.py and sms/notification_service.py --
this codebase's as-built architecture is a modular blueprint monolith with NO application
layer (app/application/ is an empty stub package; see architecture.md's 2026-07-10
reconciliation). The HTTP route stays in api/v1/admin.py; only rendering lives here.

NO PII, EVER (AC4 / NFR-3.3). The column set below is the whole contract: no NIC in any
form (not full, not last-4, not submitter_identity_hash), no citizen_nic_plain, no
citizen_mobile_plain, no raw GPS. PO-ratified 2026-08-06: canonical_id (HEC-YYYY-NNNN) is
the cross-reference key district managers use against paper DWC records -- the same
resolution Stories 5.3, 5.4 and migration 018 each reached independently.

Sinhala rendering: cases.district and cases.ds_division_id hold Sinhala names (see
backend/ml/models/district_reference.json). reportlab's built-in Type-1 fonts have no
Sinhala glyphs, so a Noto Sans Sinhala TTF is vendored under fonts/ and registered with
shapable=True (HarfBuzz via uharfbuzz) -- without shaping, Sinhala below-base vowel signs
and conjuncts render as detached glyphs. Registration degrades to Helvetica with a logged
warning rather than failing the request.
"""

import csv
import io
import logging
import os
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

logger = logging.getLogger(__name__)

# AC1's column contract. Single source of truth -- the route SELECTs in this order, the CSV
# header row is written from it, and the tests assert against it, so the three can never drift.
CSV_COLUMNS = [
    "canonical_id",
    "submitted_at",
    "damage_category",
    "ai_confidence",
    "was_overridden",
    "status",
    "approved_amount_lkr",
    "district",
    "ds_division_id",
]

# Narrower subset for the PDF -- a 9-column table on A4 landscape is unreadable, and the PDF
# is the human-facing formal report (the CSV is the complete machine-readable record).
PDF_COLUMNS = [
    ("canonical_id", "Reference"),
    ("submitted_at", "Submitted"),
    ("damage_category", "Damage"),
    ("ai_confidence", "AI Conf."),
    ("status", "Status"),
    ("approved_amount_lkr", "Approved (LKR)"),
    ("ds_division_id", "DS Division"),
]

_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_SINHALA_FONT_PATH = os.path.join(_FONT_DIR, "NotoSansSinhala-VF.ttf")
SINHALA_FONT_NAME = "NotoSansSinhala"
_FALLBACK_FONT_NAME = "Helvetica"

_registered_font = None


def _sinhala_font():
    """Registers the vendored Sinhala TTF once and returns the usable font name.

    Follows admin.py::_load_valid_districts()'s lazy-load-once shape, including its code-review
    lesson: a FAILED load is not cached. Caching the fallback on one transient read error would
    silently downgrade every PDF for the life of the worker process; retrying next call is cheap
    and self-healing.
    """
    global _registered_font
    if _registered_font is not None:
        return _registered_font
    try:
        # shapable=True routes text through HarfBuzz (uharfbuzz). Sinhala is a complex script:
        # without shaping, below-base vowel signs (e.g. U+0DD4) and yansaya/rakaransaya
        # conjuncts render as separate, mispositioned glyphs instead of composed forms.
        pdfmetrics.registerFont(TTFont(SINHALA_FONT_NAME, _SINHALA_FONT_PATH, shapable=True))
        _registered_font = SINHALA_FONT_NAME
    except Exception:
        # Never fail an export over a font problem -- a Latin-only report beats a 500.
        logger.exception("Sinhala font registration failed; falling back to %s", _FALLBACK_FONT_NAME)
        return _FALLBACK_FONT_NAME
    return _registered_font


def _fmt_datetime(value):
    """Renders a timestamp as UTC `YYYY-MM-DD HH:MM:SS`, with no offset suffix.

    cases.submitted_at is TIMESTAMPTZ, so isoformat() appends "+00:00" -- which Excel imports
    as TEXT rather than a date, breaking sorting and date filters in exactly the spreadsheet
    workflow this export exists to serve. Normalising to UTC first keeps the value unambiguous
    (the PDF header states UTC explicitly, and every timestamp here is UTC by construction)
    while staying spreadsheet-native.
    """
    if value is None:
        return ""
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(sep=" ", timespec="seconds")


def _fmt_confidence(value):
    """Confidence is DECIMAL(5,4) in [0,1]; presented as a percentage in both outputs."""
    if value is None:
        return ""
    try:
        return f"{float(value) * 100:.1f}%"
    except (TypeError, ValueError):
        return ""


def _fmt_amount(value):
    if value is None:
        return ""
    try:
        return f"{float(value):,.2f}"
    except (TypeError, ValueError):
        return ""


def _fmt_bool(value):
    # Explicitly distinguishes "no inference row at all" (None -> "") from a real False.
    # Most cases today have no inference_log row (only the officer classify path writes one),
    # so collapsing None into "false" would fabricate a finding that was never made.
    if value is None:
        return ""
    return "true" if value else "false"


def format_row(row):
    """Formats one DB row into display strings, in CSV_COLUMNS order.

    Shared by the CSV and PDF paths so the two renderings can never disagree about how a
    value is presented.
    """
    canonical_id, submitted_at, damage_category, confidence, was_overridden, status, approved, district, ds_division = row
    return {
        "canonical_id": canonical_id or "",
        "submitted_at": _fmt_datetime(submitted_at),
        "damage_category": damage_category or "",
        "ai_confidence": _fmt_confidence(confidence),
        "was_overridden": _fmt_bool(was_overridden),
        "status": status or "",
        "approved_amount_lkr": _fmt_amount(approved),
        "district": district or "",
        "ds_division_id": ds_division or "",
    }


def stream_csv(cur, batch_size=500):
    """Yields CSV text incrementally from an already-executed cursor.

    The caller owns the cursor/connection lifetime (see admin.py::export_cases) -- this
    generator only reads. fetchmany() keeps at most `batch_size` rows resident, so a
    10,000-case export never materialises as one list (AC3).

    A UTF-8 BOM is emitted first: without it Excel on Windows decodes the file as the legacy
    ANSI codepage and every Sinhala district name becomes mojibake. The BOM precedes the header
    row and is NOT part of it -- tests assert on the decoded header, not the raw first bytes.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")

    def _drain():
        value = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return value

    writer.writerow(CSV_COLUMNS)
    yield "﻿" + _drain()

    while True:
        rows = cur.fetchmany(batch_size)
        if not rows:
            break
        for row in rows:
            formatted = format_row(row)
            writer.writerow([formatted[col] for col in CSV_COLUMNS])
        yield _drain()


def build_pdf(rows, district, from_date, to_date, generated_at=None):
    """Renders the formal district report (AC2) and returns the PDF bytes.

    Text-only header -- PO-ratified 2026-08-06: no DWC logo asset exists anywhere in this
    repo, so the header carries the report title, district, range and generation timestamp
    instead. Dropping a logo in later is a one-line addition here.

    Unlike the CSV path this necessarily buffers: a PDF's cross-reference table can only be
    written once the document is complete. EXPORT_MAX_ROWS in the route is what bounds it.
    """
    font = _sinhala_font()
    generated_at = generated_at or datetime.now(timezone.utc)

    styles = getSampleStyleSheet()
    title_style = styles["Heading1"].clone("hecTitle")
    title_style.fontName = font
    meta_style = styles["Normal"].clone("hecMeta")
    meta_style.fontName = font

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title="HEC Case Report",
    )

    formatted = [format_row(r) for r in rows]
    total_approved = 0.0
    for row in rows:
        if row[6] is not None:
            try:
                total_approved += float(row[6])
            except (TypeError, ValueError):
                # A non-numeric approved_amount can't reach here through the schema
                # (NUMERIC(12,2)), but the summary must not 500 if it somehow does.
                pass

    elements = [
        Paragraph("HEC Compensation — District Case Report", title_style),
        Paragraph(f"District: {district}", meta_style),
        # Stated once here so the offset-free timestamps in the table are unambiguous.
        Paragraph("All times UTC.", meta_style),
        Paragraph(
            "Period: {} to {}".format(
                from_date.isoformat() if from_date else "All",
                to_date.isoformat() if to_date else "All",
            ),
            meta_style,
        ),
        Paragraph(
            f"Generated: {generated_at.strftime('%Y-%m-%d %H:%M UTC')}", meta_style
        ),
        Spacer(1, 8 * mm),
    ]

    header = [label for _key, label in PDF_COLUMNS]
    data = [header]
    for item in formatted:
        data.append([item[key] for key, _label in PDF_COLUMNS])

    summary = [""] * len(PDF_COLUMNS)
    summary[0] = "TOTAL"
    summary[1] = f"{len(formatted)} cases"
    summary[5] = f"{total_approved:,.2f}"
    data.append(summary)

    table = Table(data, repeatRows=1, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2D6A4F")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, -1), font),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (5, 1), (5, -1), "RIGHT"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#F2F7F2")),
            ]
        )
    )
    elements.append(table)

    doc.build(elements)
    return buf.getvalue()
