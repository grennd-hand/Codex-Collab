use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::PROTOCOL_VERSION;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    Mcp,
    Desktop,
}

impl ClientKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::Desktop => "desktop",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerBootstrap {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: String,
}

impl BrokerBootstrap {
    pub fn parse(payload: &[u8]) -> io::Result<Self> {
        let value: Self = parse_json(payload, "broker bootstrap")?;
        if value.v != PROTOCOL_VERSION || value.frame_type != "broker.bootstrap" {
            return Err(invalid_data("unsupported broker bootstrap envelope"));
        }
        Ok(value)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerReady<'a> {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub instance_id: &'a str,
    pub pipe_path: &'a str,
    pub pid: u32,
    pub capabilities: Vec<ReadyCapability>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyCapability {
    pub client_kind: ClientKind,
    pub key_id: String,
    pub secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClientHello {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub client_kind: ClientKind,
    pub key_id: String,
    pub client_nonce: String,
    pub issued_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChallenge<'a> {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub client_kind: ClientKind,
    pub key_id: &'a str,
    pub client_nonce: &'a str,
    pub server_nonce: &'a str,
    pub expires_at: u64,
    pub server_proof: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClientProof {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub client_nonce: String,
    pub server_nonce: String,
    pub client_proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationReady<'a> {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub session_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedPeer {
    pub client_kind: ClientKind,
    pub key_id: String,
    pub session_id: String,
    pub authenticated_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClientRequest {
    pub v: u32,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub method: String,
    pub params: Value,
    pub sent_at: u64,
    pub timeout_ms: u64,
}

impl ClientRequest {
    pub fn parse(payload: &[u8], client_kind: ClientKind) -> io::Result<Self> {
        let request: Self = parse_json(payload, "client request")?;
        if request.v != PROTOCOL_VERSION || request.frame_type != "request" {
            return Err(invalid_data("unsupported client request envelope"));
        }
        if !valid_identifier(&request.id, 128) {
            return Err(invalid_data("invalid request id"));
        }
        if !request.params.is_object() {
            return Err(invalid_data("params must be an object"));
        }
        if request.timeout_ms == 0 || request.timeout_ms > 120_000 {
            return Err(invalid_data("timeoutMs must be between 1 and 120000"));
        }
        if !method_allowed(client_kind, &request.method) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "method {} is not allowed for {}",
                    request.method,
                    client_kind.as_str()
                ),
            ));
        }
        Ok(request)
    }

    pub fn into_parent_frame(
        self,
        connection_id: u64,
        peer: &AuthenticatedPeer,
    ) -> io::Result<Vec<u8>> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct BrokerRequest<'a> {
            v: u32,
            #[serde(rename = "type")]
            frame_type: &'static str,
            connection_id: u64,
            peer: &'a AuthenticatedPeer,
            request: ClientRequest,
        }
        serde_json::to_vec(&BrokerRequest {
            v: PROTOCOL_VERSION,
            frame_type: "broker.request",
            connection_id,
            peer,
            request: self,
        })
        .map_err(json_error)
    }
}

#[derive(Debug)]
pub struct RoutedParentFrame {
    pub connection_id: u64,
    pub payload: Vec<u8>,
}

pub fn route_parent_frame(payload: &[u8]) -> io::Result<RoutedParentFrame> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct BrokerResponse {
        v: u32,
        #[serde(rename = "type")]
        frame_type: String,
        connection_id: u64,
        response: Value,
    }
    let frame: BrokerResponse = parse_json(payload, "broker response")?;
    if frame.v != PROTOCOL_VERSION
        || frame.frame_type != "broker.response"
        || frame.connection_id == 0
    {
        return Err(invalid_data("unsupported broker response envelope"));
    }
    validate_response(&frame.response)?;
    Ok(RoutedParentFrame {
        connection_id: frame.connection_id,
        payload: serde_json::to_vec(&frame.response).map_err(json_error)?,
    })
}

pub fn parse_client_hello(payload: &[u8]) -> io::Result<ClientHello> {
    let hello: ClientHello = parse_json(payload, "client hello")?;
    if hello.v != PROTOCOL_VERSION || hello.frame_type != "auth.hello" {
        return Err(invalid_data("unsupported client hello"));
    }
    if !valid_identifier(&hello.key_id, 128) {
        return Err(invalid_data("invalid keyId"));
    }
    validate_nonce(&hello.client_nonce, "clientNonce")?;
    validate_timestamp(hello.issued_at, "issuedAt")?;
    Ok(hello)
}

pub fn parse_client_proof(payload: &[u8]) -> io::Result<ClientProof> {
    let proof: ClientProof = parse_json(payload, "client proof")?;
    if proof.v != PROTOCOL_VERSION || proof.frame_type != "auth.proof" {
        return Err(invalid_data("unsupported client proof"));
    }
    validate_nonce(&proof.client_nonce, "clientNonce")?;
    validate_nonce(&proof.server_nonce, "serverNonce")?;
    validate_nonce(&proof.client_proof, "clientProof")?;
    Ok(proof)
}

fn validate_response(value: &Value) -> io::Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_data("broker response payload must be an object"))?;
    if object.get("v").and_then(Value::as_u64) != Some(u64::from(PROTOCOL_VERSION))
        || object.get("type").and_then(Value::as_str) != Some("response")
    {
        return Err(invalid_data("unsupported Host IPC response"));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_data("Host IPC response id is missing"))?;
    if !valid_identifier(id, 128) {
        return Err(invalid_data("invalid Host IPC response id"));
    }
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) if object.len() == 5 && object.contains_key("result") => Ok(()),
        Some(false) if object.len() == 5 && object.contains_key("error") => Ok(()),
        _ => Err(invalid_data("invalid Host IPC response shape")),
    }
}

fn method_allowed(client_kind: ClientKind, method: &str) -> bool {
    const HOST_TOOL_METHODS: &[&str] = &[
        "collab_health",
        "collab_create_session",
        "collab_recover_session",
        "collab_create_invite",
        "collab_pair_host",
        "collab_refresh_workspace",
        "collab_join_session",
        "collab_status",
        "collab_list_members",
        "collab_approve_member",
        "collab_send_message",
        "collab_list_messages",
        "collab_bind_thread",
        "collab_list_codex_threads",
        "collab_forward_prompt",
        "collab_list_files",
        "collab_read_file",
        "collab_write_file",
    ];
    (client_kind == ClientKind::Mcp && HOST_TOOL_METHODS.contains(&method))
        || method == "host.status"
        || (client_kind == ClientKind::Desktop && method == "host.gracefulStop")
}

fn validate_nonce(value: &str, label: &str) -> io::Result<()> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid_data(format!(
            "{label} must be a 32-byte base64url value"
        )));
    }
    Ok(())
}

fn validate_timestamp(value: u64, label: &str) -> io::Result<()> {
    if value > 9_007_199_254_740_991 {
        return Err(invalid_data(format!("{label} is not a safe integer")));
    }
    Ok(())
}

fn valid_identifier(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn parse_json<T: for<'de> Deserialize<'de>>(payload: &[u8], label: &str) -> io::Result<T> {
    serde_json::from_slice(payload)
        .map_err(|error| invalid_data(format!("invalid {label}: {error}")))
}

fn json_error(error: serde_json::Error) -> io::Error {
    invalid_data(error.to_string())
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str) -> Vec<u8> {
        format!(
            r#"{{"v":1,"type":"request","id":"a","method":"{method}","params":{{}},"sentAt":1,"timeoutMs":1000}}"#
        )
        .into_bytes()
    }

    #[test]
    fn enforces_canonical_method_allowlist() {
        assert!(ClientRequest::parse(&request("collab_health"), ClientKind::Mcp).is_ok());
        assert!(ClientRequest::parse(&request("collab_health"), ClientKind::Desktop).is_err());
        assert!(ClientRequest::parse(&request("host.status"), ClientKind::Mcp).is_ok());
        assert!(ClientRequest::parse(&request("host.gracefulStop"), ClientKind::Desktop).is_ok());
        assert!(ClientRequest::parse(&request("host.gracefulStop"), ClientKind::Mcp).is_err());
    }

    #[test]
    fn unwraps_canonical_broker_response() {
        let routed = route_parent_frame(
            br#"{"v":1,"type":"broker.response","connectionId":7,"response":{"v":1,"type":"response","id":"r:1","ok":true,"result":{}}}"#,
        )
        .unwrap();
        assert_eq!(routed.connection_id, 7);
        let value: Value = serde_json::from_slice(&routed.payload).unwrap();
        assert_eq!(value.get("type").and_then(Value::as_str), Some("response"));
    }

    #[test]
    fn rejects_unknown_fields_and_untyped_params() {
        assert!(
            BrokerBootstrap::parse(br#"{"v":1,"type":"broker.bootstrap","secret":"no"}"#).is_err()
        );
        let mut value: Value = serde_json::from_slice(&request("collab_health")).unwrap();
        value["params"] = Value::Array(Vec::new());
        assert!(
            ClientRequest::parse(&serde_json::to_vec(&value).unwrap(), ClientKind::Mcp).is_err()
        );
    }
}
