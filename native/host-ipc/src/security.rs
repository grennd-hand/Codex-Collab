use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::ptr::{copy_nonoverlapping, null_mut};

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::{
    EqualSid, GetLengthSid, GetTokenInformation, IsValidSid, PSECURITY_DESCRIPTOR, PSID,
    RevertToSelf, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};

pub struct PipeSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
    owner_sid: Sid,
}

// The descriptor and SID allocations are immutable for the object's lifetime.
// Windows documents the referenced structures as safe for concurrent reads.
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    pub fn for_current_user() -> io::Result<Self> {
        let owner_sid = current_process_user_sid()?;
        let sid_string = sid_to_string(&owner_sid)?;
        // A protected DACL prevents inherited ACEs. SYSTEM can administer the
        // pipe, while the current user SID is the only interactive principal.
        let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid_string})");
        let descriptor = security_descriptor_from_sddl(&sddl)?;
        Ok(Self {
            descriptor,
            owner_sid,
        })
    }

    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }

    pub fn validate_named_pipe_client(&self, pipe: HANDLE) -> io::Result<()> {
        // Impersonation is deliberately performed after the server has read the
        // client's hello frame, so Windows associates the check with that client.
        if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let validation = (|| {
            let token = open_current_thread_token()?;
            let client_sid = token_user_sid(token.0)?;
            if unsafe { EqualSid(self.owner_sid.as_psid(), client_sid.as_psid()) } == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "named-pipe client SID does not match the Host user",
                ));
            }
            Ok(())
        })();
        let revert = unsafe { RevertToSelf() };
        if revert == 0 {
            return Err(io::Error::other(format!(
                "failed to revert named-pipe impersonation: {}",
                io::Error::last_os_error()
            )));
        }
        validation
    }

    pub fn current_user_sid_hash(&self) -> String {
        let digest = Sha256::digest(self.owner_sid.as_bytes());
        let mut value = String::with_capacity(32);
        for byte in &digest[..16] {
            use std::fmt::Write as _;
            write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
        }
        value
    }

    #[cfg(test)]
    pub fn owner_sid_string(&self) -> io::Result<String> {
        sid_to_string(&self.owner_sid)
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            unsafe {
                LocalFree(self.descriptor);
            }
            self.descriptor = null_mut();
        }
    }
}

struct Sid {
    storage: Vec<usize>,
    length: usize,
}

impl Sid {
    fn copy_from(raw: PSID) -> io::Result<Self> {
        if raw.is_null() || unsafe { IsValidSid(raw) } == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid SID"));
        }
        let length = unsafe { GetLengthSid(raw) } as usize;
        let word_count = length.div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; word_count];
        unsafe {
            copy_nonoverlapping(raw.cast::<u8>(), storage.as_mut_ptr().cast::<u8>(), length);
        }
        Ok(Self { storage, length })
    }

    fn as_psid(&self) -> PSID {
        debug_assert!(self.length > 0);
        self.storage.as_ptr().cast_mut().cast::<c_void>()
    }

    fn as_bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.storage.as_ptr().cast::<u8>(), self.length) }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
            self.0 = null_mut();
        }
    }
}

fn current_process_user_sid() -> io::Result<Sid> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    token_user_sid(token.0)
}

fn open_current_thread_token() -> io::Result<OwnedHandle> {
    let mut token = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnedHandle(token))
}

fn token_user_sid(token: HANDLE) -> io::Result<Sid> {
    let mut required = 0_u32;
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
    }
    if required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::last_os_error());
    }
    let word_count = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast::<c_void>(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let token_user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    Sid::copy_from(token_user.User.Sid)
}

fn sid_to_string(sid: &Sid) -> io::Result<String> {
    let mut raw = null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_psid(), &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        let mut length = 0;
        while *raw.add(length) != 0 {
            length += 1;
        }
        String::from_utf16(&std::slice::from_raw_parts(raw, length))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SID is not valid UTF-16"))
    };
    unsafe {
        LocalFree(raw.cast());
    }
    result
}

fn security_descriptor_from_sddl(sddl: &str) -> io::Result<PSECURITY_DESCRIPTOR> {
    let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SECURITY_DESCRIPTOR_REVISION,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_current_user_and_system_security_descriptor() {
        let security = PipeSecurity::for_current_user().unwrap();
        assert!(security.owner_sid_string().unwrap().starts_with("S-1-"));
        let attributes = security.attributes();
        assert!(!attributes.lpSecurityDescriptor.is_null());
        assert_eq!(attributes.bInheritHandle, 0);
        assert_eq!(security.current_user_sid_hash().len(), 32);
    }
}
