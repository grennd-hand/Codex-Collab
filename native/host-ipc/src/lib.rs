#![cfg(windows)]

pub mod auth;
pub mod frame;
pub mod instance;
pub mod pipe;
pub mod protocol;
pub mod security;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_HANDSHAKE_FRAME_BYTES: usize = 8 * 1024;
pub const AUTH_TIMEOUT_MILLIS: u64 = 2_000;
