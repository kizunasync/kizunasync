//! The mutation ids this device pushed and saw applied, which a pull reads to
//! tell a conflict the device's own write won from one a peer's write won.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_store::{LocalStore, PUSHED_IDS_KEPT};

const NOW: &str = "2020-01-01T00:00:00.000Z";

fn mutation_id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

#[test]
fn a_recorded_id_is_remembered_and_any_other_is_not() {
    let store = LocalStore::open_in_memory().expect("open");

    store
        .record_pushed(&[mutation_id(1).as_str(), mutation_id(2).as_str()], NOW)
        .expect("record");

    assert!(store.was_pushed(&mutation_id(1)).expect("read"));
    assert!(store.was_pushed(&mutation_id(2)).expect("read"));
    assert!(!store.was_pushed(&mutation_id(3)).expect("read"));
}

#[test]
fn only_the_newest_ids_are_kept() {
    let store = LocalStore::open_in_memory().expect("open");
    let ids: Vec<String> = (1..=PUSHED_IDS_KEPT + 1).map(mutation_id).collect();
    let (first, rest) = ids.split_at(1);

    store
        .record_pushed(&[first[0].as_str()], NOW)
        .expect("record the oldest");
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
    store.record_pushed(&rest, NOW).expect("record the rest");

    assert!(
        !store.was_pushed(&first[0]).expect("read"),
        "the oldest id falls out once {PUSHED_IDS_KEPT} newer ones are kept"
    );
    for id in rest {
        assert!(store.was_pushed(id).expect("read"), "{id} is kept");
    }
}

#[test]
fn recording_an_id_again_makes_it_the_newest() {
    let store = LocalStore::open_in_memory().expect("open");
    let ids: Vec<String> = (1..=PUSHED_IDS_KEPT).map(mutation_id).collect();
    let all: Vec<&str> = ids.iter().map(String::as_str).collect();
    store.record_pushed(&all, NOW).expect("fill");

    store
        .record_pushed(&[ids[0].as_str()], NOW)
        .expect("record the oldest again");
    store
        .record_pushed(&[mutation_id(PUSHED_IDS_KEPT + 1).as_str()], NOW)
        .expect("one more");

    assert!(store.was_pushed(&ids[0]).expect("read"));
    assert!(
        !store.was_pushed(&ids[1]).expect("read"),
        "the oldest id that was not recorded again falls out"
    );
}

#[test]
fn reset_forgets_every_pushed_id() {
    let store = LocalStore::open_in_memory().expect("open");
    store
        .record_pushed(&[mutation_id(1).as_str()], NOW)
        .expect("record");

    store.reset(1, "c2").expect("reset");

    assert!(!store.was_pushed(&mutation_id(1)).expect("read"));
}
