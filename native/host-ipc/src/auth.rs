use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use zeroize::Zeroize;

use crate::AUTH_TIMEOUT_MILLIS;
use crate::protocol::{AuthenticatedPeer, ClientHello, ClientKind, ClientProof, ReadyCapability};

const NONCE_BYTES: usize = 32;
const SECRET_BYTES: usize = 32;

pub struct Capabilities {
    entries: HashMap<(ClientKind, String), Secret>,
    seen_client_nonces: Mutex<HashMap<String, u64>>,
}

impl Capabilities {
    pub fn generate() -> io::Result<Self> {
        let mut entries = HashMap::new();
        for client_kind in [ClientKind::Mcp, ClientKind::Desktop] {
            let key_id = hex(&random_bytes::<8>()?);
            entries.insert((client_kind, key_id), Secret(random_bytes()?));
        }
        Ok(Self {
            entries,
            seen_client_nonces: Mutex::new(HashMap::new()),
        })
    }

    pub fn ready_capabilities(&self) -> Vec<ReadyCapability> {
        let mut values: Vec<_> = self
            .entries
            .iter()
            .map(|((client_kind, key_id), secret)| ReadyCapability {
                client_kind: *client_kind,
                key_id: key_id.clone(),
                secret: URL_SAFE_NO_PAD.encode(secret.as_bytes()),
            })
            .collect();
        values.sort_by_key(|entry| match entry.client_kind {
            ClientKind::Mcp => 0,
            ClientKind::Desktop => 1,
        });
        values
    }

    pub fn begin(&self, hello: ClientHello, now: u64) -> io::Result<PendingAuthentication> {
        if now.abs_diff(hello.issued_at) > AUTH_TIMEOUT_MILLIS {
            return Err(permission_denied("authentication hello expired"));
        }
        let secret = self
            .entries
            .get(&(hello.client_kind, hello.key_id.clone()))
            .ok_or_else(|| permission_denied("authentication capability was rejected"))?;
        decode_exact::<NONCE_BYTES>(&hello.client_nonce, "clientNonce")?;
        let replay_key = format!("{}:{}", hello.key_id, hello.client_nonce);
        {
            let mut seen = self
                .seen_client_nonces
                .lock()
                .map_err(|_| io::Error::other("authentication replay cache was poisoned"))?;
            seen.retain(|_, expires_at| *expires_at >= now);
            if seen.contains_key(&replay_key) {
                return Err(permission_denied("authentication nonce was already used"));
            }
            seen.insert(replay_key, now.saturating_add(AUTH_TIMEOUT_MILLIS * 2));
        }
        let server_nonce = URL_SAFE_NO_PAD.encode(random_bytes::<NONCE_BYTES>()?);
        let expires_at = now.saturating_add(AUTH_TIMEOUT_MILLIS);
        let transcript = Transcript {
            v: 1,
            frame_type: "auth.challenge",
            client_kind: hello.client_kind,
            key_id: &hello.key_id,
            client_nonce: &hello.client_nonce,
            server_nonce: &server_nonce,
            expires_at,
        };
        let server_proof = proof(secret.as_bytes(), "server", &transcript)?;
        Ok(PendingAuthentication {
            client_kind: hello.client_kind,
            key_id: hello.key_id,
            client_nonce: hello.client_nonce,
            server_nonce,
            expires_at,
            server_proof,
        })
    }

    pub fn finish(
        &self,
        pending: &PendingAuthentication,
        supplied: ClientProof,
        now: u64,
    ) -> io::Result<AuthenticatedPeer> {
        if now > pending.expires_at {
            return Err(permission_denied("authentication challenge expired"));
        }
        if supplied.client_nonce != pending.client_nonce
            || supplied.server_nonce != pending.server_nonce
        {
            return Err(permission_denied("authentication transcript mismatch"));
        }
        let supplied_proof = decode_exact::<32>(&supplied.client_proof, "clientProof")?;
        let secret = self
            .entries
            .get(&(pending.client_kind, pending.key_id.clone()))
            .ok_or_else(|| permission_denied("capability expired"))?;
        let transcript = pending.transcript();
        let expected = proof_bytes(secret.as_bytes(), "client", &transcript)?;
        if !bool::from(expected.ct_eq(&supplied_proof)) {
            return Err(permission_denied("invalid client proof"));
        }
        Ok(AuthenticatedPeer {
            client_kind: pending.client_kind,
            key_id: pending.key_id.clone(),
            session_id: URL_SAFE_NO_PAD.encode(random_bytes::<NONCE_BYTES>()?),
            authenticated_at: now,
        })
    }
}

pub struct PendingAuthentication {
    pub client_kind: ClientKind,
    pub key_id: String,
    pub client_nonce: String,
    pub server_nonce: String,
    pub expires_at: u64,
    pub server_proof: String,
}

impl PendingAuthentication {
    pub fn client_nonce_encoded(&self) -> String {
        self.client_nonce.clone()
    }

    pub fn server_nonce_encoded(&self) -> String {
        self.server_nonce.clone()
    }

    fn transcript(&self) -> Transcript<'_> {
        Transcript {
            v: 1,
            frame_type: "auth.challenge",
            client_kind: self.client_kind,
            key_id: &self.key_id,
            client_nonce: &self.client_nonce,
            server_nonce: &self.server_nonce,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transcript<'a> {
    v: u32,
    #[serde(rename = "type")]
    frame_type: &'static str,
    client_kind: ClientKind,
    key_id: &'a str,
    client_nonce: &'a str,
    server_nonce: &'a str,
    expires_at: u64,
}

struct Secret([u8; SECRET_BYTES]);

impl Secret {
    fn as_bytes(&self) -> &[u8; SECRET_BYTES] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub fn random_instance_id() -> io::Result<String> {
    Ok(hex(&random_bytes::<16>()?))
}

pub fn now_millis() -> io::Result<u64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io::Error::other("system clock is before the Unix epoch"))?;
    u64::try_from(elapsed.as_millis()).map_err(|_| io::Error::other("system clock overflow"))
}

fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    // SAFETY: BCryptGenRandom writes exactly the provided buffer length. A null
    // algorithm handle is required with BCRYPT_USE_SYSTEM_PREFERRED_RNG.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            N as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other(format!(
            "BCryptGenRandom failed with NTSTATUS 0x{:08x}",
            status as u32
        )));
    }
    Ok(bytes)
}

fn proof(secret: &[u8], side: &str, transcript: &Transcript<'_>) -> io::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(proof_bytes(secret, side, transcript)?))
}

fn proof_bytes(secret: &[u8], side: &str, transcript: &Transcript<'_>) -> io::Result<[u8; 32]> {
    let mut message = format!("codex-collab-host-ipc-v1\0{side}\0").into_bytes();
    message.extend_from_slice(&serde_json::to_vec(transcript).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid transcript: {error}"),
        )
    })?);
    Ok(hmac_sha256(secret, &message))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut block = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&digest);
    block.zeroize();
    inner_pad.zeroize();
    outer_pad.zeroize();
    result
}

fn decode_exact<const N: usize>(encoded: &str, label: &str) -> io::Result<[u8; N]> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| permission_denied(format!("invalid {label} encoding")))?;
    decoded
        .try_into()
        .map_err(|_| permission_denied(format!("invalid {label} length")))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(DIGITS[(byte >> 4) as usize] as char);
        value.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    value
}

fn permission_denied(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ClientProof, parse_client_hello};

    #[test]
    fn hmac_matches_rfc_4231_case_one() {
        let key = [0x0b_u8; 20];
        assert_eq!(
            hex(&hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn matches_typescript_cross_language_golden_vector() {
        let secret = [0xa5_u8; 32];
        let client_nonce = URL_SAFE_NO_PAD.encode([0x01_u8; 32]);
        let server_nonce = URL_SAFE_NO_PAD.encode([0x02_u8; 32]);
        let transcript = Transcript {
            v: 1,
            frame_type: "auth.challenge",
            client_kind: ClientKind::Desktop,
            key_id: "desktop-main",
            client_nonce: &client_nonce,
            server_nonce: &server_nonce,
            expires_at: 3_000,
        };
        assert_eq!(
            proof(&secret, "server", &transcript).unwrap(),
            "M8a3MPWUIj-WcZwO5fKnSLQyiXv_8JUCaA-9I_x5LHk"
        );
        assert_eq!(
            proof(&secret, "client", &transcript).unwrap(),
            "LuGYzGfk4rnNbkkeJr0Q-8NnqQLCFzbl_mluP2YfY3A"
        );
    }

    #[test]
    fn handshake_proofs_match_canonical_typescript_transcript() {
        let capabilities = Capabilities::generate().unwrap();
        let ready = capabilities.ready_capabilities();
        let capability = &ready[0];
        let now = 1_800_000_000_000_u64;
        let nonce = URL_SAFE_NO_PAD.encode([1_u8; 32]);
        let hello = parse_client_hello(
            format!(
                r#"{{"v":1,"type":"auth.hello","clientKind":"{}","keyId":"{}","clientNonce":"{}","issuedAt":{}}}"#,
                capability.client_kind.as_str(), capability.key_id, nonce, now
            )
            .as_bytes(),
        )
        .unwrap();
        let pending = capabilities.begin(hello, now).unwrap();
        let secret = URL_SAFE_NO_PAD.decode(&capability.secret).unwrap();
        let client_proof = proof(&secret, "client", &pending.transcript()).unwrap();
        let peer = capabilities
            .finish(
                &pending,
                ClientProof {
                    v: 1,
                    frame_type: "auth.proof".into(),
                    client_nonce: pending.client_nonce_encoded(),
                    server_nonce: pending.server_nonce_encoded(),
                    client_proof,
                },
                now + 1,
            )
            .unwrap();
        assert_eq!(peer.client_kind, capability.client_kind);
        assert_eq!(peer.session_id.len(), 43);
    }

    #[test]
    fn rejects_replayed_hello_nonce() {
        let capabilities = Capabilities::generate().unwrap();
        let capability = &capabilities.ready_capabilities()[0];
        let now = 1_800_000_000_000_u64;
        let wire = format!(
            r#"{{"v":1,"type":"auth.hello","clientKind":"{}","keyId":"{}","clientNonce":"{}","issuedAt":{}}}"#,
            capability.client_kind.as_str(),
            capability.key_id,
            URL_SAFE_NO_PAD.encode([3_u8; 32]),
            now
        );
        assert!(
            capabilities
                .begin(parse_client_hello(wire.as_bytes()).unwrap(), now)
                .is_ok()
        );
        assert!(
            capabilities
                .begin(parse_client_hello(wire.as_bytes()).unwrap(), now)
                .is_err()
        );
    }
}
