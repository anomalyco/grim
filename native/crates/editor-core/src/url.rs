//! Link chip URLs: which hrefs may be opened.

/// Only http(s) and mailto links are opened; a URL without a scheme is treated as https.
/// Returns the normalized URL (lowercase scheme/host, "/" path for an empty http(s) path), a
/// minimal stand-in for WHATWG `new URL(...).href`.
pub fn safe_url(href: &str) -> Option<String> {
    let has_scheme = {
        let b = href.as_bytes();
        let n = b.iter().take_while(|&&c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'+' | b'.' | b'-')).count();
        !b.is_empty() && b[0].is_ascii_alphabetic() && b.get(n) == Some(&b':')
    };
    let full = if has_scheme { href.to_string() } else { format!("https://{href}") };
    let colon = full.find(':')?;
    let scheme = full[..colon].to_ascii_lowercase();
    let rest = &full[colon + 1..];
    match scheme.as_str() {
        "mailto" => Some(format!("mailto:{rest}")),
        "http" | "https" => {
            let rest = rest.trim_start_matches(['/', '\\']);
            let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
            let (auth, tail) = rest.split_at(end);
            let (user, host) = match auth.rfind('@') {
                Some(i) => (&auth[..=i], &auth[i + 1..]),
                None => ("", auth),
            };
            if host.is_empty() || host.chars().any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '^' | '|' | '%' | '"')) {
                return None;
            }
            let tail = if tail.is_empty() || tail.starts_with(['?', '#']) { format!("/{tail}") } else { tail.replace('\\', "/") };
            Some(format!("{scheme}://{user}{}{tail}", host.to_lowercase()))
        }
        _ => None,
    }
}
