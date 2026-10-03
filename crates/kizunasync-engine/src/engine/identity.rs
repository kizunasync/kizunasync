//! Which user a store belongs to, read from the `sub` claim of the tokens the
//! host sets.
//!
//! The first subject a token names becomes the store's owner, and every
//! `bucket_owner` table routes its pull on it. A token that names another
//! subject latches the soft block with
//! [`SoftBlockReason::IdentityChanged`] until [`SyncEngine::reset`], so one
//! user's queued writes are never pushed under another user's session. The
//! token is decoded, never verified: the server verifies it on every call, and
//! the engine only has to notice that the store changed hands.

use super::{OWNER_SUBJECT_KEY, SyncEngine};
use crate::config::SoftBlockReason;
use crate::error::EngineError;
use std::sync::PoisonError;

impl SyncEngine {
    /// Replace the user JWT the remote and the transfer port send on their next
    /// call. `None` clears it.
    ///
    /// A token whose `sub` claim names another user than the store's owner
    /// latches the soft block with [`SoftBlockReason::IdentityChanged`] and
    /// emits `RESET_REQUIRED`; the first subject a store sees becomes its
    /// owner and fills the `bucket_owner` tables' bucket value. A token
    /// without a readable subject and a cleared token change neither the owner
    /// nor the block.
    pub fn set_remote_access_token(&self, token: Option<String>) {
        match token.as_deref() {
            None => self.remember_token_subject(None),
            Some(token) => {
                if let Some(subject) = subject_claim(token) {
                    self.remember_token_subject(Some(subject));
                }
            }
        }
        self.remote.set_access_token(token.clone());
        if let Some(transfer) = &self.transfer {
            transfer.set_access_token(token);
        }

        // If the store cannot run this check right now, it runs again and fails the call before the next pull or push.
        let _ = self.check_token_subject();
    }

    /// Whether the next pull or push must stay off the network: the soft block,
    /// read after the current token's subject was checked against the owner.
    ///
    /// # Errors
    /// [`EngineError::Store`] when the owner, the latch, or the block cannot
    /// be read or written.
    pub(crate) fn blocks_network(&self) -> Result<bool, EngineError> {
        self.check_token_subject()?;
        self.is_soft_blocked()
    }

    /// Keep the subject of the token the remote now sends. A cleared token
    /// forgets it, so a store reset while signed out records no stale owner.
    fn remember_token_subject(&self, subject: Option<String>) {
        *self
            .token_subject
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = subject;
    }

    /// Record the current token's subject as the owner of a store that has
    /// none and fill the owner buckets with it, or latch the soft block when
    /// it names another subject. The latch leaves the owner buckets as they
    /// were. A store already blocked for this reason is left as it is, so a
    /// refreshed token of the new user announces nothing twice.
    fn check_token_subject(&self) -> Result<(), EngineError> {
        let Some(subject) = self
            .token_subject
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        else {
            return Ok(());
        };

        let owner = self.meta_get(OWNER_SUBJECT_KEY)?;
        if owner.is_empty() {
            // Filled first: a fill that fails leaves the owner unrecorded, so the next check fills again.
            self.fill_owner_buckets(&subject)?;
            return self.meta_set(OWNER_SUBJECT_KEY, &subject);
        }
        if owner == subject || self.soft_block_reason()? == Some(SoftBlockReason::IdentityChanged) {
            return Ok(());
        }

        let announcement = self
            .store
            .transaction(|| self.latch_soft_block(SoftBlockReason::IdentityChanged))?;
        self.emit(&announcement);
        Ok(())
    }
}

/// The `sub` claim of a compact JWS, or `None` when `token` is not three
/// segments whose middle one is base64url JSON carrying a non-empty string
/// `sub`.
fn subject_claim(token: &str) -> Option<String> {
    let mut segments = token.split('.');
    let (Some(_header), Some(payload), Some(_signature), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return None;
    };

    let claims: serde_json::Value = serde_json::from_slice(&decode_base64url(payload)?).ok()?;
    claims
        .get("sub")?
        .as_str()
        .filter(|subject| !subject.is_empty())
        .map(str::to_owned)
}

/// Decode unpadded base64url (RFC 4648 section 5), tolerating trailing `=`
/// padding. `None` for any other character or an impossible length.
fn decode_base64url(text: &str) -> Option<Vec<u8>> {
    let text = text.trim_end_matches('=');
    if text.len() % 4 == 1 {
        return None;
    }

    let mut bytes = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for symbol in text.bytes() {
        let sextet = match symbol {
            b'A'..=b'Z' => symbol - b'A',
            b'a'..=b'z' => symbol - b'a' + 26,
            b'0'..=b'9' => symbol - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((buffer >> bits) & 0xFF).ok()?);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(bytes)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{SoftBlockReason, decode_base64url, subject_claim};
    use crate::config::EngineEvent;
    use serde_json::json;

    #[test]
    fn base64url_decodes_every_remainder_length() {
        assert_eq!(decode_base64url("").unwrap(), b"");
        assert_eq!(decode_base64url("Zg").unwrap(), b"f");
        assert_eq!(decode_base64url("Zm8").unwrap(), b"fo");
        assert_eq!(decode_base64url("Zm9v").unwrap(), b"foo");
        assert_eq!(decode_base64url("Zm9vYg").unwrap(), b"foob");
        assert_eq!(decode_base64url("Zm9vYmE").unwrap(), b"fooba");
        assert_eq!(decode_base64url("Zm9vYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn base64url_reads_the_url_safe_symbols_and_tolerates_padding() {
        assert_eq!(decode_base64url("-_8").unwrap(), [0xfb, 0xff]);
        assert_eq!(decode_base64url("Zg==").unwrap(), b"f");
    }

    #[test]
    fn base64url_refuses_the_standard_alphabet_and_impossible_lengths() {
        assert_eq!(decode_base64url("+/8"), None);
        assert_eq!(decode_base64url("Zm9vY"), None);
        assert_eq!(decode_base64url("Zm 9v"), None);
    }

    #[test]
    fn the_subject_is_the_sub_claim_of_the_payload() {
        // {"alg":"HS256"} . {"sub":"u-1","role":"authenticated"} . signature
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2ln";

        assert_eq!(subject_claim(token).as_deref(), Some("u-1"));
    }

    #[test]
    fn a_token_without_a_readable_subject_has_none() {
        for token in [
            "",
            "opaque",
            "a.b",
            "a.b.c.d",
            "eyJhbGciOiJIUzI1NiJ9.!!.c2ln",
            // payload: [1]
            "eyJhbGciOiJIUzI1NiJ9.WzFd.c2ln",
            // payload: {"sub":1}
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln",
            // payload: {"sub":""}
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIifQ.c2ln",
            // payload: {"role":"anon"}
            "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln",
        ] {
            assert_eq!(subject_claim(token), None, "{token}");
        }
    }

    #[test]
    fn a_reason_reads_back_the_spelling_it_is_stored_and_serialized_under() {
        for reason in [
            SoftBlockReason::ResetRequired,
            SoftBlockReason::IdentityChanged,
        ] {
            assert_eq!(SoftBlockReason::parse(reason.as_str()), Some(reason));
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::json!(reason.as_str())
            );
        }
        assert_eq!(SoftBlockReason::parse("RESET_REQUIRED"), None);
    }

    #[test]
    fn the_reset_required_event_spells_a_reason_only_when_it_carries_one() {
        let named = EngineEvent::ResetRequired {
            reason: Some(SoftBlockReason::IdentityChanged),
        };
        let unnamed = EngineEvent::ResetRequired { reason: None };

        assert_eq!(
            serde_json::to_value(&named).unwrap(),
            json!({ "type": "RESET_REQUIRED", "reason": "identity_changed" })
        );
        assert_eq!(
            serde_json::to_value(&unnamed).unwrap(),
            json!({ "type": "RESET_REQUIRED" })
        );
        assert!(matches!(
            serde_json::from_value(json!({ "type": "RESET_REQUIRED" })).unwrap(),
            EngineEvent::ResetRequired { reason: None }
        ));
        assert!(matches!(
            serde_json::from_value(json!({ "type": "RESET_REQUIRED", "reason": "reset_required" }))
                .unwrap(),
            EngineEvent::ResetRequired {
                reason: Some(SoftBlockReason::ResetRequired)
            }
        ));
    }
}
