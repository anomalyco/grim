//! Cheap structural checks on a Yjs v1 update before yrs integrates it. yrs 0.28 trusts its input: some
//! well-formed but bogus updates (zero-length blocks, a client listed twice, nested types or map keys in our
//! text, clock overflows, empty delete ranges) panic inside it (e.g. a division by zero in
//! `BlockSet::find_index`), which in the browser's `panic=abort` build kills the whole engine. Our documents
//! only ever hold one root text ("md") of strings, embeds, formats and deleted items, so anything else is
//! rejected here as an error instead. Skip blocks are rejected too: only merged updates have them, and the
//! server relays its own transactions' updates, never merged ones.

use std::collections::HashSet;

use yrs::encoding::read::{Cursor, Read};

/// Clocks above this are rejected (far beyond any real document, far from u32 overflow).
const MAX_CLOCK: u64 = 1 << 30;

/// Checks `update`; returns where each client's blocks start (client, clock).
pub fn check_update(update: &[u8], text_name: &str) -> Result<Vec<(u64, u32)>, String> {
    let mut c = Cursor::new(update);
    let e = |s: &str| Err(format!("bad update: {s}"));
    let rd = |c: &mut Cursor, what: &str| -> Result<u64, String> { c.read_var::<u64>().map_err(|err| format!("bad update ({what}): {err}")) };
    let n_clients = rd(&mut c, "clients")?;
    if n_clients > update.len() as u64 {
        return e("client count");
    }
    let mut seen = HashSet::new();
    let mut starts = Vec::new();
    for _ in 0..n_clients {
        let n_blocks = rd(&mut c, "blocks")?;
        if n_blocks > update.len() as u64 {
            return e("block count");
        }
        let client = rd(&mut c, "client")?;
        if !seen.insert(client) {
            return e("client listed twice");
        }
        let mut clock = rd(&mut c, "clock")?;
        if clock > MAX_CLOCK {
            return e("clock");
        }
        starts.push((client, clock as u32));
        for _ in 0..n_blocks {
            let info = c.read_u8().map_err(|err| format!("bad update (info): {err}"))?;
            let len = match info {
                0 => rd(&mut c, "length")?,
                10 => return e("skip block"),
                _ => {
                    let (origin, right) = (info & 0x80 != 0, info & 0x40 != 0);
                    for has in [origin, right] {
                        if has {
                            rd(&mut c, "origin client")?;
                            if rd(&mut c, "origin clock")? > MAX_CLOCK {
                                return e("origin clock");
                            }
                        }
                    }
                    if !origin && !right {
                        if rd(&mut c, "parent")? != 1 {
                            return e("nested parent");
                        }
                        if read_str(&mut c)? != text_name {
                            return e("another root type");
                        }
                        if info & 0x20 != 0 {
                            return e("map key");
                        }
                    }
                    match info & 0x1f {
                        1 => rd(&mut c, "deleted length")?,
                        4 => read_str(&mut c)?.encode_utf16().count() as u64,
                        5 => {
                            read_str(&mut c)?;
                            1
                        }
                        6 => {
                            read_str(&mut c)?;
                            read_str(&mut c)?;
                            1
                        }
                        _ => return e("content type"),
                    }
                }
            };
            if len == 0 {
                return e("empty block");
            }
            clock += len;
            if clock > MAX_CLOCK {
                return e("clock");
            }
        }
    }
    let n_del = rd(&mut c, "delete set")?;
    if n_del > update.len() as u64 {
        return e("delete set count");
    }
    for _ in 0..n_del {
        rd(&mut c, "delete client")?;
        let n = rd(&mut c, "delete ranges")?;
        if n > update.len() as u64 {
            return e("delete range count");
        }
        for _ in 0..n {
            let (clock, len) = (rd(&mut c, "delete clock")?, rd(&mut c, "delete length")?);
            if len == 0 || clock + len > MAX_CLOCK {
                return e("delete range");
            }
        }
    }
    Ok(starts)
}

fn read_str<'a>(c: &mut Cursor<'a>) -> Result<&'a str, String> {
    let len = c.read_var::<u32>().map_err(|err| format!("bad update (string): {err}"))? as usize;
    let buf: &'a [u8] = c.buf;
    let bytes = buf.get(c.next..c.next.saturating_add(len)).ok_or("bad update: string past the end")?;
    c.next += len;
    std::str::from_utf8(bytes).map_err(|_| "bad update: string not UTF-8".to_string())
}
