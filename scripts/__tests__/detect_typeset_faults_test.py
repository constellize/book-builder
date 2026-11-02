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

pytestmark = pytest.mark.skipif(
    not os.path.exists(PDF),
    reason=f"fixture PDF absent (gitignored, 105MB): {PDF}")


@pytest.fixture(scope="module")
def faults():
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
