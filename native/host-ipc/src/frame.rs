use std::io::{self, Read, Write};

pub fn read_frame<R: Read>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        match reader.read(&mut header[read..])? {
            0 if read == 0 => return Ok(None),
            0 => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated frame header",
                ));
            }
            count => read += count,
        }
    }

    let length = u32::from_le_bytes(header) as usize;
    validate_frame_length(length, max_bytes)?;
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8], max_bytes: usize) -> io::Result<()> {
    validate_frame_length(payload.len(), max_bytes)?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

pub fn validate_frame_length(length: usize, max_bytes: usize) -> io::Result<()> {
    if length == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zero-length frames are not allowed",
        ));
    }
    if length > max_bytes || length > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} exceeds limit {max_bytes}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_little_endian_frame() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, br#"{"ok":true}"#, 1024).unwrap();
        assert_eq!(&bytes[..4], &[11, 0, 0, 0]);
        assert_eq!(
            read_frame(&mut bytes.as_slice(), 1024).unwrap().unwrap(),
            br#"{"ok":true}"#
        );
    }

    #[test]
    fn rejects_empty_oversized_and_truncated_frames() {
        assert!(validate_frame_length(0, 10).is_err());
        assert!(validate_frame_length(11, 10).is_err());
        assert!(read_frame(&mut &[4, 0, 0][..], 10).is_err());
        assert!(read_frame(&mut &[4, 0, 0, 0, 1][..], 10).is_err());
    }
}
