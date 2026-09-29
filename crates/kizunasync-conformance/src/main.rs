//! `kizunasync-conformance` binary: replay the protocol corpus against the Rust
//! engine and print `corpus: passed=<n> failed=<n> skipped_steps=<n>`.

#![forbid(unsafe_code)]

use kizunasync_conformance::{repo_root_from_cwd, run_all_non_blocked};

#[tokio::main]
async fn main() {
    let root = repo_root_from_cwd();
    match run_all_non_blocked(&root).await {
        Ok(summary) => {
            println!(
                "corpus: passed={} failed={} skipped_steps={}",
                summary.passed, summary.failed, summary.skipped_steps
            );
            for e in summary.failures {
                eprintln!("FAIL {e}");
            }
            if summary.failed > 0 {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("harness error: {e}");
            std::process::exit(2);
        }
    }
}
