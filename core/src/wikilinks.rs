//! M10: deterministic document link extraction — no LLM, reads only relationships the author explicitly stated.
//! Body `[[name]]`/`[[name|display]]` → rel_type "links",
//! frontmatter `metadata.up` → "up", `metadata.related` → "related".
//! Parse failures always resolve to an empty result without panicking (called from the ingest path).

use serde_yaml::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExtractedLink {
    /// "links" | "up" | "related"
    pub rel_type: String,
    /// Normalized target name (alias stripped, trimmed, lowercased)
    pub target_name: String,
}

/// A document's "name" = the stem (with .md removed) of the last path segment of its origin, lowercased.
/// `C:\...\pvec-vectorizer.md` → `pvec-vectorizer`,
/// `knowledge://john/folder/note.md` → `note`; non-file origins like URLs also resolve to their last segment.
pub fn doc_name_from_origin(origin: &str) -> String {
    let last = origin.rsplit(['/', '\\']).next().unwrap_or(origin);
    let stem = last.strip_suffix(".md").or_else(|| last.strip_suffix(".MD")).unwrap_or(last);
    stem.trim().to_lowercase()
}

/// Normalizes the inner name of `[[name]]`/`[[name|alias]]`, or a plain string, into a link target name.
fn normalize_target(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if let Some(inner) = s.strip_prefix("[[").and_then(|x| x.strip_suffix("]]")) {
        s = inner;
    }
    let name = s.split('|').next().unwrap_or(s).trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_lowercase())
}

/// Extracts all `[[...]]` from the body (no code-fence distinction — by wiki convention, a link is a link).
fn extract_body_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = text[i + 2..].find("]]") {
                let inner = &text[i + 2..i + 2 + end];
                // Treat it as not a wikilink if there's a newline inside (guards against accidental bracket matches).
                if !inner.contains('\n') {
                    if let Some(name) = normalize_target(inner) {
                        out.push(name);
                    }
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Reads frontmatter's metadata.up (scalar) / metadata.related (list|scalar).
/// Also allows top-level up/related (absorbs formatting variance between wiki and memory).
fn extract_frontmatter_relations(text: &str) -> (Vec<String>, Vec<String>) {
    let mut ups = Vec::new();
    let mut relateds = Vec::new();
    let Some(block) = extract_block(text) else {
        return (ups, relateds);
    };
    let Ok(value) = serde_yaml::from_str::<Value>(&block) else {
        return (ups, relateds);
    };
    let Some(map) = value.as_mapping() else {
        return (ups, relateds);
    };

    let scopes: Vec<&serde_yaml::Mapping> = {
        let mut v = vec![map];
        if let Some(meta) = get_value(map, "metadata").and_then(Value::as_mapping) {
            v.push(meta);
        }
        v
    };
    for scope in scopes {
        collect_names(get_value(scope, "up"), &mut ups);
        collect_names(get_value(scope, "related"), &mut relateds);
    }
    (ups, relateds)
}

fn collect_names(value: Option<&Value>, out: &mut Vec<String>) {
    match value {
        Some(Value::String(s)) => {
            if let Some(n) = normalize_target(s) {
                out.push(n);
            }
        }
        Some(Value::Sequence(seq)) => {
            for item in seq {
                if let Some(s) = item.as_str() {
                    if let Some(n) = normalize_target(s) {
                        out.push(n);
                    }
                }
            }
        }
        _ => {}
    }
}

fn get_value<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a Value> {
    map.iter().find_map(|(k, v)| if k.as_str() == Some(key) { Some(v) } else { None })
}

fn extract_block(text: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized = text.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

/// Extracts links across the whole document. Dedups by (rel_type, target), excludes self (doc_name).
pub fn extract_links(text: &str, doc_name: &str) -> Vec<ExtractedLink> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut push = |rel_type: &str, name: String| {
        if name == doc_name {
            return; // exclude self-link
        }
        let link = ExtractedLink { rel_type: rel_type.to_string(), target_name: name };
        if seen.insert(link.clone()) {
            out.push(link);
        }
    };

    let (ups, relateds) = extract_frontmatter_relations(text);
    for n in ups {
        push("up", n);
    }
    for n in relateds {
        push("related", n);
    }
    // The body scan excludes the frontmatter block — prevents up/related from being double-extracted as links.
    for n in extract_body_links(body_after_frontmatter(text)) {
        push("links", n);
    }
    out
}

/// If a frontmatter block exists, returns only the body after its closing `---`.
fn body_after_frontmatter(text: &str) -> &str {
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = stripped.strip_prefix("---\n").or_else(|| stripped.strip_prefix("---\r\n")) else {
        return text;
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            after.trim_start_matches(['-']).trim_start_matches(['\r', '\n'])
        }
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_variants_yield_stem_names() {
        assert_eq!(doc_name_from_origin(r"C:\Users\U\.claude\wiki\pvec-vectorizer.md"), "pvec-vectorizer");
        assert_eq!(doc_name_from_origin("knowledge://철수/폴더/노트.md"), "노트");
        assert_eq!(doc_name_from_origin("http://arxiv.org/abs/2607.09422v1"), "2607.09422v1");
    }

    #[test]
    fn extracts_body_frontmatter_dedup_alias_and_self_exclusion() {
        let text = "---\nname: my-doc\nmetadata:\n  up: \"[[moc-tooling]]\"\n  related:\n    - \"[[directive-knowledge-loop]]\"\n    - \"[[_ontology]]\"\n---\n본문에서 [[rag-staging-branch-exclusion-set]] 참고, 별칭 [[node-sse-req-close-vs-res-close|SSE 교훈]] 그리고 중복 [[rag-staging-branch-exclusion-set]] 재언급. 자기 자신 [[my-doc]] 언급은 제외.\n";
        let links = extract_links(text, "my-doc");
        let pairs: Vec<(String, String)> =
            links.iter().map(|l| (l.rel_type.clone(), l.target_name.clone())).collect();
        assert!(pairs.contains(&("up".into(), "moc-tooling".into())));
        assert!(pairs.contains(&("related".into(), "directive-knowledge-loop".into())));
        assert!(pairs.contains(&("related".into(), "_ontology".into())));
        assert!(pairs.contains(&("links".into(), "rag-staging-branch-exclusion-set".into())));
        assert!(pairs.contains(&("links".into(), "node-sse-req-close-vs-res-close".into())));
        assert_eq!(pairs.iter().filter(|(_, t)| t == "rag-staging-branch-exclusion-set").count(), 1, "중복 dedup");
        assert!(!pairs.iter().any(|(_, t)| t == "my-doc"), "자기링크 제외");
        assert_eq!(links.len(), 5);
    }

    #[test]
    fn malformed_inputs_never_panic() {
        assert!(extract_links("[[unclosed", "x").is_empty());
        // a[[0]] and [[0]] dedup to the same target "0" as one match; the newline-containing [[a\nb]] is excluded.
        assert_eq!(extract_links("배열 인덱스 a[[0]] 같은 코드도 [[0]]으로 잡히지만 개행 [[a\nb]]는 제외", "x").len(), 1);
        assert!(extract_links("", "x").is_empty());
    }
}
