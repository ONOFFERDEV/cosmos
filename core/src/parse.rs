//! Input normalization and content hashing.
//!
//! Normalization is intentionally minimal: CRLF -> LF unification only.
//! Everything else in the original text is preserved verbatim, since
//! chunk anchors (`char_start`/`char_end`) are byte offsets into this
//! normalized text and must stay stable/reproducible.

use sha2::{Digest, Sha256};

/// Normalize raw input text: unify line endings to `\n`, preserve everything else.
pub fn normalize(text: &str) -> String {
    // Handle CRLF first, then any stray lone CR.
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// SHA-256 hex digest of the given bytes, used for reindex dedup/replace detection.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_crlf_and_lone_cr() {
        assert_eq!(normalize("a\r\nb\rc\n"), "a\nb\nc\n");
    }

    #[test]
    fn preserves_lf_only_text() {
        assert_eq!(normalize("a\nb\nc"), "a\nb\nc");
    }

    #[test]
    fn hash_is_stable() {
        let a = sha256_hex(b"hello");
        let b = sha256_hex(b"hello");
        assert_eq!(a, b);
        assert_ne!(a, sha256_hex(b"hello2"));
    }
}
