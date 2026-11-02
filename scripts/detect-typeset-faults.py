#!/usr/bin/env python3
"""
Detect the typesetting fault classes the publisher reports, so before/after is measured
not eyeballed.

Each detector looks for the VISIBLE SYMPTOM in the finished PDF, because that is what a
reader sees and what the publisher reviewed. None of them read the LaTeX source.

Run:  python3 detect-typeset-faults.py build/print/constellize-book.pdf [--json out.json]
Test: cd book-builder && uv run pytest scripts/__tests__/detect_typeset_faults_test.py -v
"""
import subprocess, sys, re, json

# A running head carries the folio on the SAME line under -layout: the folio leads on a
# verso ("106     Chapter 4. ...") and trails on a recto ("4.1. ...        107"). Strip it
# explicitly or the first line of every headed page reads as content.
RUNNING_HEAD = re.compile(r'^\s*\d+\s{2,}\S|\S\s{2,}\d+\s*$')
BARE_FOLIO = re.compile(r'\s*\d+\s*')
# A line made only of closing delimiters: "}", "]", ");", "})" ... (p80's tail is "]").
CLOSERS_ONLY = re.compile(r'[\s\)\]\}>;,]+')
CAPTION = re.compile(r'^\s*Figure\s')
# A footnote body under -layout: a bare mark line ("a") then a URL line ("https : / / ...").
FOOTNOTE_MARK = re.compile(r'^\s*[a-z]\s*$')
URL_LINE = re.compile(r'^\s*https?\s*:')

KEYS = ('1_figure_in_callout', '2_orphan_tail', '3_word_across_figure',
        '4_widow_orphan', '5_missing_glyph')


def extract_pages(pdf):
    raw = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True).stdout
    pages = raw.split('\f')
    # pdftotext ends every page, including the last, with a form feed, so the split leaves a
    # trailing empty segment that is not a page.
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def find_faults(pdf_path):
    """Scan a PDF; return {'page_count': int, '<class key>': [findings...]}."""
    pages = extract_pages(pdf_path)
    N = len(pages)

    def lines(p, drop_head=True):
        ls = [l.rstrip() for l in pages[p-1].split('\n') if l.strip()]
        if drop_head and ls and RUNNING_HEAD.search(ls[0]):
            ls = ls[1:]
        return ls

    def bodylines(p):
        return [l for l in lines(p) if not BARE_FOLIO.fullmatch(l)]

    def has_caption(p):
        return any(CAPTION.match(l) for l in lines(p))

    def leading_footnote(p):
        """True if, ignoring the caption, the page's first content is a footnote body.
        That footnote belongs to a reference on an earlier page: its callout was split
        and the figure floated in between."""
        rest = [l for l in bodylines(p) if not CAPTION.match(l)]
        # a caption may wrap onto continuation lines; skip lines until the first mark line,
        # but only look at the first few so a page's own footnotes at the foot do not count
        for i, l in enumerate(rest[:4]):
            if FOOTNOTE_MARK.match(l) and i + 1 < len(rest) and URL_LINE.match(rest[i+1]):
                return True
        return False

    findings = {k: [] for k in KEYS}

    for p in range(2, N + 1):
        ls = lines(p)
        if not ls:
            continue
        prevb = bodylines(p-1)
        firstb = (bodylines(p) or [''])[0]

        # 5. missing glyph
        for l in ls:
            if '\ufffd' in l:
                findings['5_missing_glyph'].append({'page': p, 'text': l.strip()[:70]})

        # 2. orphaned tail: page opens with nothing but closing delimiters, or a word
        #    hyphenated across the page break
        if firstb and CLOSERS_ONLY.fullmatch(firstb):
            findings['2_orphan_tail'].append({'page': p, 'text': firstb.strip(), 'kind': 'lone closer'})
        elif prevb and firstb:
            if prevb[-1].rstrip().endswith('-') and re.match(r'^[a-z]', firstb.strip()):
                kind = ('word split across a FIGURE page'
                        if has_caption(p-1) or has_caption(p) else 'word split across break')
                key = '3_word_across_figure' if 'FIGURE' in kind else '2_orphan_tail'
                findings[key].append({'page': p, 'text': f'{prevb[-1].strip()[-28:]} | {firstb.strip()[:28]}', 'kind': kind})

        # 1. figure landing inside a callout. The figure need NOT be alone on the page
        #    (p215 of v0.6.3 carries twenty body lines). Two symptoms, either suffices:
        #    (a) the figure's page opens with the footnote of a callout from the page before;
        #    (b) a word is hyphenated across the figure's page.
        #    A URL at the foot of the previous page is NOT a symptom: a footnote body
        #    legitimately ends with an unpunctuated URL (p34, p49, p99 are clean).
        if has_caption(p):
            if leading_footnote(p):
                findings['1_figure_in_callout'].append(
                    {'page': p, 'text': (prevb[-1].strip()[-34:] if prevb else ''),
                     'kind': 'callout footnote displaced past figure'})
            else:
                nxtb = bodylines(p+1) if p < N else []
                if prevb and nxtb:
                    tail, head = prevb[-1].strip(), nxtb[0].strip()
                    if tail.endswith('-'):
                        findings['1_figure_in_callout'].append(
                            {'page': p, 'text': f'{tail[-34:]} | {head[:34]}', 'kind': 'word split across figure page'})

        # 4. widow/orphan: previous page ends on a lead-in line
        if prevb and prevb[-1].rstrip().endswith(':') and len(prevb[-1].strip()) > 12:
            findings['4_widow_orphan'].append({'page': p-1, 'text': prevb[-1].strip()[:64], 'kind': 'lead-in stranded at page foot'})

    for k in findings:
        seen = set(); uniq = []
        for f in findings[k]:
            sig = (f['page'], f.get('text'))
            if sig in seen:
                continue
            seen.add(sig); uniq.append(f)
        findings[k] = uniq

    findings['page_count'] = N
    return findings


def main(argv):
    args = argv[1:]
    out = None
    if '--json' in args:
        i = args.index('--json')
        out = args[i+1]
        del args[i:i+2]
    pdf = args[0] if args else 'build/print/constellize-book.pdf'
    findings = find_faults(pdf)
    print(f"  {pdf}  --  {findings['page_count']} pages\n")
    for k in KEYS:
        label = k.split('_', 1)[1].replace('_', ' ')
        print(f"  S{k[0]}  {label:<26} {len(findings[k])}")
    print()
    text = json.dumps(findings, indent=1)
    if out:
        with open(out, 'w') as fh:
            fh.write(text + '\n')
    else:
        print(text)


if __name__ == '__main__':
    main(sys.argv)
