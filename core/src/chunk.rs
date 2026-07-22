//! Chunking of normalized document text.
//!
//! Anchor invariant (CONTRACT.md, gate-critical):
//! - `char_start`/`char_end` are UTF-8 **byte** offsets into the normalized
//!   full document text, aligned to character boundaries.
//! - `text.len() == char_end - char_start`
//! - `doc_text[char_start..char_end] == text`
//!
//! Split preference: heading > blank line > sentence boundary > hard cut,
//! always landing on a UTF-8 char boundary. Target size 1500 bytes, overlap
//! 200 bytes (CONTRACT.md constants).

use crate::{CHUNK_OVERLAP_BYTES, CHUNK_TARGET_BYTES};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub text: String,
    pub char_start: usize,
    pub char_end: usize,
    pub section: Option<String>,
}

/// Find markdown heading line starts: `(byte_offset_of_line_start, heading_text)`.
fn find_headings(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&hashes) {
            if let Some(rest) = trimmed.get(hashes..) {
                if let Some(stripped) = rest.strip_prefix(' ') {
                    let heading_text = stripped.trim().to_string();
                    if !heading_text.is_empty() {
                        out.push((pos, heading_text));
                    }
                }
            }
        }
        pos += line.len();
    }
    out
}

fn section_for(headings: &[(usize, String)], pos: usize) -> Option<String> {
    headings
        .iter()
        .filter(|(p, _)| *p <= pos)
        .next_back()
        .map(|(_, h)| h.clone())
}

/// Floor `idx` down to the nearest UTF-8 char boundary of `text`.
fn floor_char_boundary(text: &str, mut idx: usize) -> usize {
    if idx >= text.len() {
        return text.len();
    }
    while idx > 0 && !text.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Locate the best split point in `(window_lo, ideal_end]`, preferring
/// heading > blank line > sentence boundary > hard cut at `ideal_end`.
fn find_split_point(text: &str, start: usize, ideal_end: usize, headings: &[(usize, String)]) -> usize {
    // `ideal_end` and `window_lo` arrive as raw byte offsets and may land
    // inside a multi-byte char (e.g. Korean text with no ASCII separators
    // near the target size). Align both to char boundaries before they are
    // used to slice or bound any candidate.
    let ideal_end = floor_char_boundary(text, ideal_end);
    let window_lo = floor_char_boundary(text, (start + CHUNK_TARGET_BYTES / 3).min(ideal_end).max(start));
    if window_lo >= ideal_end {
        return ideal_end;
    }
    let window = &text[window_lo..ideal_end];

    // 1. Heading start closest to (but not exceeding) ideal_end.
    if let Some(p) = headings
        .iter()
        .map(|(p, _)| *p)
        .filter(|&p| p > window_lo && p <= ideal_end)
        .max()
    {
        return p;
    }

    // 2. Blank line (paragraph boundary).
    if let Some(rel) = window.rfind("\n\n") {
        let cand = window_lo + rel + 2;
        return floor_char_boundary(text, cand.min(ideal_end));
    }

    // 3. Sentence boundary.
    let mut best: Option<usize> = None;
    for pat in [". ", "! ", "? ", ".\n", "!\n", "?\n"] {
        if let Some(rel) = window.rfind(pat) {
            let cand = window_lo + rel + 1; // right after the punctuation mark
            best = Some(best.map_or(cand, |b: usize| b.max(cand)));
        }
    }
    if let Some(p) = best {
        return floor_char_boundary(text, p);
    }

    // 4. Hard cut.
    floor_char_boundary(text, ideal_end)
}

/// Chunk normalized text per CONTRACT.md rules.
pub fn chunk_text(text: &str) -> Vec<Chunk> {
    let len = text.len();
    if len == 0 {
        return Vec::new();
    }
    let headings = find_headings(text);
    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < len {
        let ideal_end = (start + CHUNK_TARGET_BYTES).min(len);
        let mut end = if ideal_end >= len {
            len
        } else {
            find_split_point(text, start, ideal_end, &headings)
        };
        // Guarantee forward progress: end must land strictly after start,
        // on a char boundary.
        if end <= start {
            let mut next = start + 1;
            while next < len && !text.is_char_boundary(next) {
                next += 1;
            }
            end = next.min(len);
        }

        let section = section_for(&headings, start);
        chunks.push(Chunk {
            text: text[start..end].to_string(),
            char_start: start,
            char_end: end,
            section,
        });

        if end >= len {
            break;
        }

        let raw_next = end.saturating_sub(CHUNK_OVERLAP_BYTES);
        let next_start = if raw_next <= start {
            end
        } else {
            floor_char_boundary(text, raw_next)
        };
        start = if next_start > start { next_start } else { end };
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_anchors_valid(text: &str, chunks: &[Chunk]) {
        for c in chunks {
            assert_eq!(c.text.len(), c.char_end - c.char_start, "len mismatch for {:?}", c);
            assert_eq!(
                &text.as_bytes()[c.char_start..c.char_end],
                c.text.as_bytes(),
                "slice mismatch for {:?}",
                c
            );
        }
    }

    #[test]
    fn empty_text_yields_no_chunks() {
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn short_text_single_chunk() {
        let text = "hello world";
        let chunks = chunk_text(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, text);
        assert_anchors_valid(text, &chunks);
    }

    #[test]
    fn heading_becomes_section() {
        let text = "# Title\n\nSome intro text.\n\n## Sub\n\nMore body text here.";
        let chunks = chunk_text(text);
        assert_anchors_valid(text, &chunks);
        assert!(chunks.iter().any(|c| c.section.as_deref() == Some("Title") || c.section.as_deref() == Some("Sub")));
    }

    #[test]
    fn long_text_produces_multiple_chunks_with_valid_anchors() {
        let mut text = String::new();
        for i in 0..200 {
            text.push_str(&format!("Sentence number {i} in a long document about testing chunkers. "));
        }
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 1);
        assert_anchors_valid(&text, &chunks);
        // Every char in the doc should be covered by at least one chunk (overlap allowed).
        assert_eq!(chunks.first().unwrap().char_start, 0);
        assert_eq!(chunks.last().unwrap().char_end, text.len());
    }

    #[test]
    fn korean_multibyte_text_char_boundaries_hold() {
        let mut text = String::new();
        for i in 0..300 {
            text.push_str(&format!("이것은 한국어 테스트 문장입니다 번호 {i}. "));
        }
        let chunks = chunk_text(&text);
        assert!(!chunks.is_empty());
        assert_anchors_valid(&text, &chunks);
    }

    /// Regression test for a panic observed during seed indexing:
    /// `find_split_point` sliced `text[window_lo..ideal_end]` using raw byte
    /// offsets that were not char-boundary aligned, panicking on Korean text.
    /// This text has no headings, no blank lines, and no sentence-ending
    /// punctuation, so every chunk boundary is forced through the hard-cut
    /// path with no ASCII separator nearby to "accidentally" align on.
    #[test]
    fn korean_no_punctuation_forces_hard_cut_char_boundaries_hold() {
        let text = "가나다라마바사아자차".repeat(500);
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 1);
        assert_anchors_valid(&text, &chunks);
        assert_eq!(chunks.first().unwrap().char_start, 0);
        assert_eq!(chunks.last().unwrap().char_end, text.len());
    }
}
