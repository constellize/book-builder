"""Regression tests for detect-typeset-faults.py against the v0.6.3 round-7 print PDF.

The detector scored zero on this PDF twice while a human found faults on p80 and p215;
these tests pin those true positives. The PDF is large and gitignored, so tests skip
when it is absent.
"""
import importlib.util
import os
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "detect_typeset_faults", os.path.join(HERE, "..", "detect-typeset-faults.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

# book-builder/scripts/__tests__ -> book/
BOOK = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PDF = os.path.join(BOOK, "publisher/round-7/outgoing/constellize-book-round-7-print-v0.6.3.pdf")

@pytest.fixture(scope="module")
def faults():
    if not os.path.exists(PDF):
        pytest.skip(f"fixture PDF absent (gitignored, 105MB): {PDF}")
    return mod.find_faults(PDF)


def test_finds_orphaned_bracket_tail_on_p80(faults):
    assert any(x["page"] == 80 for x in faults["2_orphan_tail"])


def test_finds_figure_in_callout_on_p215(faults):
    assert any(x["page"] == 215 for x in faults["1_figure_in_callout"])


def test_page_count_is_257_not_258(faults):
    assert faults["page_count"] == 257


def test_closers_only_pattern_rejects_prose():
    assert mod.CLOSERS_ONLY.fullmatch("]")
    assert mod.CLOSERS_ONLY.fullmatch("  });")
    assert not mod.CLOSERS_ONLY.fullmatch("] and then")


def test_p105_is_orphan_tail_not_figure_in_callout(faults):
    # p105 opens with a callout footnote shed from p104; Figure 4.3 sits BELOW it, so the
    # figure is not between the callout and its footnote. That is class 2, not class 1.
    assert any(x["page"] == 105 for x in faults["2_orphan_tail"])
    assert not any(x["page"] == 105 for x in faults["1_figure_in_callout"])


def test_p215_is_figure_in_callout_not_orphan_tail(faults):
    # p215: the caption comes first and the displaced footnote after it.
    assert any(x["page"] == 215 for x in faults["1_figure_in_callout"])
    assert not any(x["page"] == 215 for x in faults["2_orphan_tail"])


def _pages(faults, key):
    return {x["page"] for x in faults[key]}


def test_exact_class_1_pages(faults):
    assert _pages(faults, "1_figure_in_callout") == {215}


def test_exact_class_2_pages(faults):
    assert _pages(faults, "2_orphan_tail") == {80, 105, 108, 112, 141}


def test_known_false_positives_stay_clean(faults):
    # p35/p49/p100 follow a page ending in a complete, unpunctuated footnote URL; an
    # earlier "previous page contains http" rule falsely flagged them.
    for key in ("1_figure_in_callout", "2_orphan_tail"):
        assert not ({35, 49, 100} & _pages(faults, key))


# These do not need the fixture PDF, so they must run even when it is absent.
@pytest.mark.parametrize("path", ["/nonexistent/nope.pdf", __file__])
def test_unreadable_pdf_raises_instead_of_reporting_zero(path):
    with pytest.raises(RuntimeError):
        mod.find_faults(path)


def _tiny_pdf(path, text):
    """A one-page PDF carrying `text`; pdftotext rebuilds the xref, so offsets need not be exact."""
    stream = f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            "/Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = "%PDF-1.4\n"
    for i, o in enumerate(objs):
        out += f"{i+1} 0 obj\n{o}\nendobj\n"
    out += "trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n"
    path.write_text(out, encoding="latin-1")
    return str(path)


def test_provenance_reads_version_from_pdf_front_matter(tmp_path, monkeypatch):
    # The PDF is stamped 0.1.2. Decoys say 9.9.9 in the cwd, beside the PDF, and in their
    # templates/ dirs. The REAL book-builder/templates/metadata.yaml (the copy the build
    # uses, which is where the trap lives) says something else again; the stamp must differ
    # from it, so a regression that reads it fails here too.
    real_template = os.path.join(HERE, "..", "..", "templates", "metadata.yaml")
    if os.path.exists(real_template):
        assert "0.1.2" not in open(real_template).read()
    for d in [tmp_path / "metadata.yaml", tmp_path / "templates" / "metadata.yaml",
              tmp_path / "pdfdir" / "metadata.yaml",
              tmp_path / "pdfdir" / "templates" / "metadata.yaml"]:
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_text('version: "9.9.9"\n')
    monkeypatch.chdir(tmp_path)
    pdf = _tiny_pdf(tmp_path / "pdfdir" / "b.pdf", "Author Preview v0.1.2")
    p = mod.provenance(pdf)
    assert p["source_pdf"] == pdf
    assert p["book_version"] == "0.1.2"
    assert p["generated_at"].endswith("+00:00")


def test_provenance_version_is_none_without_a_stamp(tmp_path):
    pdf = _tiny_pdf(tmp_path / "b.pdf", "Just some text")
    assert mod.provenance(pdf)["book_version"] is None


def test_provenance_version_is_none_for_unreadable_pdf(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_text("not a pdf")
    assert mod.provenance(str(bad))["book_version"] is None
