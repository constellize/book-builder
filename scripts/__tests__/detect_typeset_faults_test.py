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
