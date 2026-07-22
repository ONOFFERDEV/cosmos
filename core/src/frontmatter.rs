//! M7: YAML frontmatter parsing for the entity registry. Self-contained —
//! no dependency on `store`/`engine`. Any parse failure (missing
//! frontmatter, malformed YAML, missing `name`/`title`) yields `None`;
//! this must never panic, since `ingest_doc` calls it on arbitrary text.

use serde_yaml::Value;

/// Fields extracted from a document's frontmatter, mapped onto the
/// `entities` table / `Entity` API shape (CONTRACT.md M7 / openapi.yaml).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EntityFields {
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub next_action: Option<String>,
    pub blocked_on: Option<String>,
    pub updated: Option<String>,
}

/// Parses a `---\n...\n---` YAML frontmatter block at the start of `text`
/// (BOM-tolerant, CRLF-tolerant) into `EntityFields`. Returns `None` if
/// there's no frontmatter, the YAML doesn't parse, the top level isn't a
/// mapping, or neither `name` nor `title` is present. A field whose value
/// is a non-scalar (list/map) is dropped to `None` rather than failing the
/// whole parse.
pub fn parse(text: &str) -> Option<EntityFields> {
    let block = extract_block(text)?;
    let value: Value = serde_yaml::from_str(&block).ok()?;
    let map = value.as_mapping()?;

    let name = get_str(map, "name").or_else(|| get_str(map, "title"))?;

    let metadata = map.get_key("metadata").and_then(Value::as_mapping);

    let kind = metadata
        .and_then(|m| get_str(m, "type"))
        .or_else(|| get_str(map, "category"))
        .unwrap_or_else(|| "unknown".to_string());

    let description = get_str(map, "description");
    let status = metadata.and_then(|m| get_str(m, "project_status"));
    let phase = metadata.and_then(|m| get_str(m, "phase"));
    let next_action = metadata.and_then(|m| get_str(m, "next"));
    let blocked_on = metadata.and_then(|m| get_str(m, "blocked_on"));
    let updated = metadata.and_then(|m| get_str(m, "updated")).or_else(|| get_str(map, "updated"));

    Some(EntityFields { name, kind, description, status, phase, next_action, blocked_on, updated })
}

/// Extracts the raw YAML between the opening/closing `---` delimiters at
/// the document start. Strips a leading UTF-8 BOM and normalizes CRLF to
/// LF first so both line-ending styles are accepted.
fn extract_block(text: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized = text.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

/// Looks up a scalar string at `key` in a YAML mapping by iterating and
/// comparing keys via `Value::as_str`, sidestepping any version-specific
/// `Mapping::get`-by-`&str` API. Scalars other than strings (numbers,
/// bools) are stringified; sequences/mappings/null yield `None`.
fn get_str(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.iter().find_map(|(k, v)| {
        if k.as_str() != Some(key) {
            return None;
        }
        match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    })
}

/// Small helper trait-free shim so `map.get_key(...)` reads naturally above
/// without depending on `Mapping::get`'s exact key-type API.
trait MappingExt {
    fn get_key(&self, key: &str) -> Option<&Value>;
}

impl MappingExt for serde_yaml::Mapping {
    fn get_key(&self, key: &str) -> Option<&Value> {
        self.iter().find_map(|(k, v)| if k.as_str() == Some(key) { Some(v) } else { None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Memory-style" frontmatter: nested `metadata` block with Korean
    /// values, matching this repo's own `~/.claude/projects/*/memory/*.md`
    /// convention.
    #[test]
    fn parses_nested_metadata_with_korean_values() {
        let text = "---\nname: cosmos-knowledge-universe\ndescription: 회사 공용 살아있는 지식 코스모스\nmetadata:\n  type: project\n  project_status: active\n  phase: M7\n  next: 다이제스트 생성\n  blocked_on: null\n  updated: 2026-07-14\n---\n\n본문 내용\n";
        let fields = parse(text).expect("should parse frontmatter");
        assert_eq!(fields.name, "cosmos-knowledge-universe");
        assert_eq!(fields.description.as_deref(), Some("회사 공용 살아있는 지식 코스모스"));
        assert_eq!(fields.kind, "project");
        assert_eq!(fields.status.as_deref(), Some("active"));
        assert_eq!(fields.phase.as_deref(), Some("M7"));
        assert_eq!(fields.next_action.as_deref(), Some("다이제스트 생성"));
        assert_eq!(fields.blocked_on, None);
        assert_eq!(fields.updated.as_deref(), Some("2026-07-14"));
    }

    /// "Wiki-style" frontmatter: flat fields (`title`/`category`/`updated`),
    /// no nested `metadata` block.
    #[test]
    fn parses_flat_wiki_style() {
        let text = "---\ntitle: threejs-instancedmesh-vertexcolors-black\ncategory: debugging\nupdated: 2026-06-01\n---\nbody\n";
        let fields = parse(text).expect("should parse frontmatter");
        assert_eq!(fields.name, "threejs-instancedmesh-vertexcolors-black");
        assert_eq!(fields.kind, "debugging");
        assert_eq!(fields.updated.as_deref(), Some("2026-06-01"));
        assert_eq!(fields.status, None);
        assert_eq!(fields.phase, None);
    }

    #[test]
    fn no_frontmatter_yields_none() {
        assert_eq!(parse("just plain text\nwith no frontmatter block\n"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn malformed_yaml_yields_none_without_panic() {
        let text = "---\nname: [unclosed\n---\nbody\n";
        assert_eq!(parse(text), None);

        let text2 = "---\n\"unterminated string\n---\n";
        assert_eq!(parse(text2), None);

        // No closing delimiter at all.
        let text3 = "---\nname: x\nno closing fence here\n";
        assert_eq!(parse(text3), None);

        // Frontmatter present but neither `name` nor `title` -> None.
        let text4 = "---\ndescription: only a description\n---\nbody\n";
        assert_eq!(parse(text4), None);
    }
}
