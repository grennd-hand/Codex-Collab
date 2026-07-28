use std::io;
use std::ptr::null_mut;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile,
    WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, PeekNamedPipe,
};

use crate::frame::validate_frame_length;
use crate::security::PipeSecurity;

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);

pub struct PipeHandle(HANDLE);

unsafe impl Send for PipeHandle {}
unsafe impl Sync for PipeHandle {}

impl PipeHandle {
    pub fn create(path: &str, security: &PipeSecurity, first: bool) -> io::Result<Self> {
        let wide = wide(path);
        let mut open_mode = PIPE_ACCESS_DUPLEX;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let attributes = security.attributes();
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                2_000,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    pub fn connect(&self) -> io::Result<()> {
        if unsafe { ConnectNamedPipe(self.0, null_mut()) } != 0 {
            return Ok(());
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_PIPE_CONNECTED {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(error as i32))
        }
    }

    pub fn read_frame(&self, max_bytes: usize) -> io::Result<Vec<u8>> {
        let mut header = [0_u8; 4];
        self.read_exact(&mut header)?;
        let length = u32::from_le_bytes(header) as usize;
        validate_frame_length(length, max_bytes)?;
        let mut payload = vec![0_u8; length];
        self.read_exact(&mut payload)?;
        Ok(payload)
    }

    pub fn read_frame_until(&self, deadline: Instant, max_bytes: usize) -> io::Result<Vec<u8>> {
        let mut header = [0_u8; 4];
        self.read_exact_until(&mut header, deadline)?;
        let length = u32::from_le_bytes(header) as usize;
        validate_frame_length(length, max_bytes)?;
        let mut payload = vec![0_u8; length];
        self.read_exact_until(&mut payload, deadline)?;
        Ok(payload)
    }

    pub fn write_frame(&self, payload: &[u8], max_bytes: usize) -> io::Result<()> {
        validate_frame_length(payload.len(), max_bytes)?;
        self.write_all(&(payload.len() as u32).to_le_bytes())?;
        self.write_all(payload)
    }

    pub fn disconnect(&self) {
        unsafe {
            DisconnectNamedPipe(self.0);
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }

    fn read_exact(&self, buffer: &mut [u8]) -> io::Result<()> {
        let mut offset = 0;
        while offset < buffer.len() {
            let mut count = 0_u32;
            let result = unsafe {
                ReadFile(
                    self.0,
                    buffer[offset..].as_mut_ptr(),
                    (buffer.len() - offset).min(u32::MAX as usize) as u32,
                    &mut count,
                    null_mut(),
                )
            };
            if result == 0 {
                return Err(last_pipe_error());
            }
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "named pipe closed while reading",
                ));
            }
            offset += count as usize;
        }
        Ok(())
    }

    fn read_exact_until(&self, buffer: &mut [u8], deadline: Instant) -> io::Result<()> {
        let mut offset = 0;
        while offset < buffer.len() {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "named-pipe authentication timed out",
                ));
            }
            let available = self.available_bytes()? as usize;
            if available == 0 {
                thread::sleep(POLL_INTERVAL);
                continue;
            }
            let length = available.min(buffer.len() - offset);
            let mut count = 0_u32;
            let result = unsafe {
                ReadFile(
                    self.0,
                    buffer[offset..].as_mut_ptr(),
                    length as u32,
                    &mut count,
                    null_mut(),
                )
            };
            if result == 0 {
                return Err(last_pipe_error());
            }
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "named pipe closed during authentication",
                ));
            }
            offset += count as usize;
        }
        Ok(())
    }

    fn available_bytes(&self) -> io::Result<u32> {
        let mut available = 0_u32;
        if unsafe {
            PeekNamedPipe(
                self.0,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            return Err(last_pipe_error());
        }
        Ok(available)
    }

    fn write_all(&self, buffer: &[u8]) -> io::Result<()> {
        let mut offset = 0;
        while offset < buffer.len() {
            let mut count = 0_u32;
            let result = unsafe {
                WriteFile(
                    self.0,
                    buffer[offset..].as_ptr(),
                    (buffer.len() - offset).min(u32::MAX as usize) as u32,
                    &mut count,
                    null_mut(),
                )
            };
            if result == 0 {
                return Err(last_pipe_error());
            }
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "named pipe accepted a zero-byte write",
                ));
            }
            offset += count as usize;
        }
        Ok(())
    }
}

impl Drop for PipeHandle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
            unsafe {
                DisconnectNamedPipe(self.0);
                CloseHandle(self.0);
            }
            self.0 = INVALID_HANDLE_VALUE;
        }
    }
}

pub fn wake_server(path: &str) {
    let wide = wide(path);
    for _ in 0..20 {
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(handle);
            }
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn last_pipe_error() -> io::Error {
    let error = unsafe { GetLastError() };
    if error == ERROR_BROKEN_PIPE {
        io::Error::new(io::ErrorKind::BrokenPipe, "named-pipe peer disconnected")
    } else {
        io::Error::from_raw_os_error(error as i32)
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::random_instance_id;
    use crate::security::PipeSecurity;
    use std::sync::mpsc;

    #[test]
    fn current_user_connects_and_passes_explicit_sid_validation() {
        let path = format!(
            r"\\.\pipe\codex-collab-host-test-{}",
            random_instance_id().unwrap()
        );
        let security = PipeSecurity::for_current_user().unwrap();
        let server = PipeHandle::create(&path, &security, true).unwrap();
        let (connected_tx, connected_rx) = mpsc::channel();
        let client_path = path.clone();
        let client = thread::spawn(move || {
            let wide = wide(&client_path);
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null_mut(),
                    OPEN_EXISTING,
                    0,
                    null_mut(),
                )
            };
            assert_ne!(handle, INVALID_HANDLE_VALUE);
            let mut written = 0;
            assert_ne!(
                unsafe { WriteFile(handle, b"x".as_ptr(), 1, &mut written, null_mut()) },
                0
            );
            assert_eq!(written, 1);
            connected_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(100));
            unsafe {
                CloseHandle(handle);
            }
        });
        server.connect().unwrap();
        let mut byte = [0_u8; 1];
        server.read_exact(&mut byte).unwrap();
        connected_rx.recv().unwrap();
        security.validate_named_pipe_client(server.raw()).unwrap();
        client.join().unwrap();
    }
}
