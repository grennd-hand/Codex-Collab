use std::io;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows_sys::Win32::System::Threading::CreateMutexW;

use crate::security::PipeSecurity;

pub const EXIT_HOST_ALREADY_RUNNING: i32 = 23;

pub struct UserHostMutex {
    handle: HANDLE,
}

impl UserHostMutex {
    pub fn acquire(security: &PipeSecurity) -> io::Result<Self> {
        let name = format!(
            r"Local\CodexCollabHost-{}",
            security.current_user_sid_hash()
        );
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let attributes = security.attributes();
        let handle = unsafe { CreateMutexW(&attributes, 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "host_already_running: the per-user Host mutex already exists",
            ));
        }
        Ok(Self { handle })
    }
}

impl Drop for UserHostMutex {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = null_mut();
        }
    }
}
