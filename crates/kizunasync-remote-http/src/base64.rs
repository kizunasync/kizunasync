//! Standard padded base64 encoding for TUS `Upload-Metadata`.
//!
//! Encoding only, ~20 lines: a whole dependency for one header would fail the
//! "deps minimal" bar in @../../../CONVENTIONS.md.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let triple = u32::from(chunk.first().copied().unwrap_or(0)) << 16
            | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        for (index, shift) in [(0_usize, 18_u32), (1, 12), (2, 6), (3, 0)] {
            if index <= chunk.len() {
                let sextet = usize::try_from((triple >> shift) & 0x3F).unwrap_or(0);
                out.push(char::from(ALPHABET[sextet]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::encode;

    #[test]
    fn matches_the_rfc4648_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
        assert_eq!(encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_upload_metadata_values_encode_with_and_without_padding() {
        assert_eq!(encode(b"media"), "bWVkaWE=");
        assert_eq!(encode(b"u1/p1.bin"), "dTEvcDEuYmlu");
    }
}
