//! M10: 결정론 문서 링크 추출 — LLM 무사용, 저자가 명시한 관계만 읽는다.
//! 본문 `[[이름]]`/`[[이름|표시]]` → rel_type "links",
//! frontmatter `metadata.up` → "up", `metadata.related` → "related".
//! 파싱 실패는 어떤 경우에도 panic 없이 빈 결과로 수렴한다(ingest 경로에서 호출됨).

use serde_yaml::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExtractedLink {
    /// "links" | "up" | "related"
    pub rel_type: String,
    /// 정규화된 대상 이름(별칭 제거·trim·소문자)
    pub target_name: String,
}

/// 문서의 "이름" = origin 마지막 경로 세그먼트의 스템(.md 제거), 소문자.
/// `C:\...\pvec-vectorizer.md` → `pvec-vectorizer`,
/// `knowledge://철수/폴더/노트.md` → `노트`, URL 등 비파일 origin도 마지막 세그먼트로 수렴.
pub fn doc_name_from_origin(origin: &str) -> String {
    let last = origin.rsplit(['/', '\\']).next().unwrap_or(origin);
    let stem = last.strip_suffix(".md").or_else(|| last.strip_suffix(".MD")).unwrap_or(last);
    stem.trim().to_lowercase()
}

/// `[[name]]`/`[[name|alias]]` 내부 이름 또는 일반 문자열을 링크 대상 이름으로 정규화.
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

/// 본문에서 `[[...]]` 전부 추출(코드펜스 구분 없이 — 위키 관례상 링크는 링크다).
fn extract_body_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = text[i + 2..].find("]]") {
                let inner = &text[i + 2..i + 2 + end];
                // 링크 내부에 개행이 있으면 위키링크가 아니라고 본다(대괄호 우연 일치 방어).
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

/// frontmatter의 metadata.up(스칼라) / metadata.related(리스트|스칼라)를 읽는다.
/// 최상위 up/related도 허용(위키·메모리 양식 편차 흡수).
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

/// 문서 전체에서 링크를 추출한다. (rel_type, target) 단위 dedup, 자기 자신(doc_name) 제외.
pub fn extract_links(text: &str, doc_name: &str) -> Vec<ExtractedLink> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut push = |rel_type: &str, name: String| {
        if name == doc_name {
            return; // 자기링크 제외
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
    // 본문 스캔은 frontmatter 블록을 제외한다 — up/related가 links로 이중 추출되는 것 방지.
    for n in extract_body_links(body_after_frontmatter(text)) {
        push("links", n);
    }
    out
}

/// frontmatter 블록이 있으면 그 닫는 `---` 이후의 본문만 돌려준다.
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
        // a[[0]]과 [[0]]은 같은 대상 "0"으로 dedup되어 1건, 개행 포함 [[a\nb]]는 제외.
        assert_eq!(extract_links("배열 인덱스 a[[0]] 같은 코드도 [[0]]으로 잡히지만 개행 [[a\nb]]는 제외", "x").len(), 1);
        assert!(extract_links("", "x").is_empty());
    }
}
