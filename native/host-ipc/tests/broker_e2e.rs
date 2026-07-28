use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use codex_collab_host_ipc::frame::{read_frame, write_frame};
use codex_collab_host_ipc::{MAX_FRAME_BYTES, MAX_HANDSHAKE_FRAME_BYTES};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[test]
fn proxies_an_authenticated_canonical_request() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_codex-collab-host-ipc"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut parent_input = child.stdin.take().unwrap();
    let mut parent_output = child.stdout.take().unwrap();

    write_json_frame(
        &mut parent_input,
        &json!({ "v": 1, "type": "broker.bootstrap" }),
        MAX_HANDSHAKE_FRAME_BYTES,
    );
    let broker_ready = read_json_frame(&mut parent_output, MAX_HANDSHAKE_FRAME_BYTES);
    assert_eq!(broker_ready["type"], "broker.ready");

    let contender = Command::new(env!("CARGO_BIN_EXE_codex-collab-host-ipc"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(contender.status.code(), Some(23));
    assert!(
        contender.stdout.is_empty(),
        "a second broker must not become ready"
    );
    assert!(
        String::from_utf8_lossy(&contender.stderr).contains("host_already_running"),
        "second broker did not report the stable already-running marker"
    );
    let capability = broker_ready["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["clientKind"] == "mcp")
        .unwrap();
    let pipe_path = broker_ready["pipePath"].as_str().unwrap();
    let key_id = capability["keyId"].as_str().unwrap();
    let secret = URL_SAFE_NO_PAD
        .decode(capability["secret"].as_str().unwrap())
        .unwrap();

    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_path)
        .unwrap();
    let client_nonce = URL_SAFE_NO_PAD.encode([1_u8; 32]);
    let issued_at = now_millis();
    write_json_frame(
        &mut pipe,
        &json!({
            "v": 1,
            "type": "auth.hello",
            "clientKind": "mcp",
            "keyId": key_id,
            "clientNonce": client_nonce,
            "issuedAt": issued_at,
        }),
        MAX_HANDSHAKE_FRAME_BYTES,
    );
    let challenge = read_json_frame(&mut pipe, MAX_HANDSHAKE_FRAME_BYTES);
    let transcript = Transcript {
        v: 1,
        frame_type: "auth.challenge",
        client_kind: "mcp",
        key_id,
        client_nonce: challenge["clientNonce"].as_str().unwrap(),
        server_nonce: challenge["serverNonce"].as_str().unwrap(),
        expires_at: challenge["expiresAt"].as_u64().unwrap(),
    };
    assert_eq!(
        challenge["serverProof"],
        proof(&secret, "server", &transcript)
    );
    write_json_frame(
        &mut pipe,
        &json!({
            "v": 1,
            "type": "auth.proof",
            "clientNonce": transcript.client_nonce,
            "serverNonce": transcript.server_nonce,
            "clientProof": proof(&secret, "client", &transcript),
        }),
        MAX_HANDSHAKE_FRAME_BYTES,
    );
    let auth_ready = read_json_frame(&mut pipe, MAX_HANDSHAKE_FRAME_BYTES);
    assert_eq!(auth_ready["type"], "auth.ready");

    write_json_frame(
        &mut pipe,
        &json!({
            "v": 1,
            "type": "request",
            "id": "request-1",
            "method": "collab_health",
            "params": {},
            "sentAt": now_millis(),
            "timeoutMs": 30_000,
        }),
        MAX_FRAME_BYTES,
    );
    let broker_request = read_json_frame(&mut parent_output, MAX_FRAME_BYTES);
    assert_eq!(broker_request["type"], "broker.request");
    assert_eq!(broker_request["peer"]["clientKind"], "mcp");
    assert_eq!(broker_request["request"]["method"], "collab_health");
    let connection_id = broker_request["connectionId"].as_u64().unwrap();

    write_json_frame(
        &mut parent_input,
        &json!({
            "v": 1,
            "type": "broker.response",
            "connectionId": connection_id,
            "response": {
                "v": 1,
                "type": "response",
                "id": "request-1",
                "ok": true,
                "result": { "status": "ok" },
            },
        }),
        MAX_FRAME_BYTES,
    );
    let response = read_json_frame(&mut pipe, MAX_FRAME_BYTES);
    assert_eq!(response["type"], "response");
    assert_eq!(response["result"]["status"], "ok");

    drop(pipe);
    drop(parent_input);
    let status = child.wait().unwrap();
    assert!(status.success(), "broker failed with status {status}");

    let mut replacement = Command::new(env!("CARGO_BIN_EXE_codex-collab-host-ipc"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut replacement_input = replacement.stdin.take().unwrap();
    let mut replacement_output = replacement.stdout.take().unwrap();
    write_json_frame(
        &mut replacement_input,
        &json!({ "v": 1, "type": "broker.bootstrap" }),
        MAX_HANDSHAKE_FRAME_BYTES,
    );
    let replacement_ready = read_json_frame(&mut replacement_output, MAX_HANDSHAKE_FRAME_BYTES);
    assert_eq!(replacement_ready["type"], "broker.ready");
    drop(replacement_input);
    assert!(replacement.wait().unwrap().success());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transcript<'a> {
    v: u32,
    #[serde(rename = "type")]
    frame_type: &'static str,
    client_kind: &'a str,
    key_id: &'a str,
    client_nonce: &'a str,
    server_nonce: &'a str,
    expires_at: u64,
}

fn write_json_frame(writer: &mut impl Write, value: &Value, limit: usize) {
    write_frame(writer, &serde_json::to_vec(value).unwrap(), limit).unwrap();
}

fn read_json_frame(reader: &mut impl Read, limit: usize) -> Value {
    serde_json::from_slice(&read_frame(reader, limit).unwrap().unwrap()).unwrap()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn proof(secret: &[u8], side: &str, transcript: &Transcript<'_>) -> String {
    let mut message = format!("codex-collab-host-ipc-v1\0{side}\0").into_bytes();
    message.extend_from_slice(&serde_json::to_vec(transcript).unwrap());
    URL_SAFE_NO_PAD.encode(hmac_sha256(secret, &message))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    outer.finalize().into()
}
