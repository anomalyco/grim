//! GPT-Live's JSON events on the `oai-events` data channel. The `POST` started the session, so there's no
//! `session.start`; the client mutes, unmutes and closes, and `voice::delegate` appends.

use serde_json::{Value, json};

#[derive(Debug, PartialEq)]
pub enum Server {
    Started,
    /// What the voice is saying.
    Output(String),
    /// What it heard you say.
    Input(String),
    Muted(bool),
    Closed(String),
    /// `session.delegation.created`: its id.
    Delegation(String),
    /// `session.{thinking,commentary,instructions}.appended`: the `client_event_id`.
    Appended(String),
    Error(String),
    /// Anything else (its type).
    Other(String),
}

pub fn parse(data: &[u8]) -> Option<Server> {
    let v: Value = serde_json::from_slice(data).ok()?;
    let ty = v["type"].as_str()?;
    let delta = || v["delta"].as_str().unwrap_or_default().to_string();
    Some(match ty {
        "session.started" => Server::Started,
        "session.output_transcript.delta" => Server::Output(delta()),
        "session.input_transcript.delta" => Server::Input(delta()),
        "session.input_audio.muted" => Server::Muted(true),
        "session.input_audio.unmuted" => Server::Muted(false),
        "session.delegation.created" => Server::Delegation(v["delegation"]["id"].as_str().unwrap_or_default().to_string()),
        "session.thinking.appended" | "session.commentary.appended" | "session.instructions.appended" => Server::Appended(v["client_event_id"].as_str().unwrap_or_default().to_string()),
        "session.closed" => Server::Closed(v["reason"].as_str().unwrap_or("closed").to_string()),
        "error" => {
            let m = v["error"]["message"].as_str().unwrap_or("The voice service reported an error.").to_string();
            Server::Error(match v["error"]["client_event_id"].as_str().or(v["client_event_id"].as_str()) {
                Some(id) => format!("{m} (event {id})"),
                None => m,
            })
        }
        other => Server::Other(other.to_string()),
    })
}

pub fn mute(on: bool) -> String {
    let ty = if on { "session.input_audio.mute" } else { "session.input_audio.unmute" };
    json!({ "type": ty, "event_id": format!("event_{}", if on { "mute" } else { "unmute" }) }).to_string()
}

pub fn close() -> String {
    json!({ "type": "session.close", "event_id": "event_close" }).to_string()
}
