//! The crate's public error types stay usable as `std::error::Error` by an embedder.

use kizunasync_store::{StoreError, TransformError};

fn assert_error<E: std::error::Error + Send + Sync + 'static>() {}

#[test]
fn transform_error_implements_std_error_and_is_exported() {
    assert_error::<TransformError>();
    assert_error::<StoreError>();
}
