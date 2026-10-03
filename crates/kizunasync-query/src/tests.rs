use super::*;
use serde_json::{Value, json};

fn row(v: &Value) -> Row {
    v.as_object().cloned().expect("object")
}

#[test]
fn a_range_a_pattern_and_a_search_all_match_and_the_plan_returns_the_row() {
    let r = row(&json!({"id":"p1","title":"Alpha","rank":2,"done":false}));
    assert!(
        matches_filter(
            &r,
            &Filter::Gt {
                column: "rank".into(),
                value: json!(1)
            }
        )
        .unwrap()
    );
    assert!(
        matches_filter(
            &r,
            &Filter::Ilike {
                column: "title".into(),
                pattern: "a%".into()
            }
        )
        .unwrap()
    );
    assert!(
        matches_filter(
            &r,
            &Filter::Search {
                query: "alp".into(),
                columns: None
            }
        )
        .unwrap()
    );

    let plan = QueryPlan {
        filters: vec![Filter::Gte {
            column: "rank".into(),
            value: json!(2),
        }],
        orders: vec![OrderBy {
            column: "rank".into(),
            ascending: true,
            nulls_first: None,
        }],
        limit: Some(10),
        offset: None,
        projection: None,
        cardinality: "many".into(),
        include_deleted: false,
        count: false,
    };
    let out = apply_query(vec![r], &plan).unwrap();
    match out {
        QueryResult::Many(rows) => assert_eq!(rows.len(), 1),
        _ => panic!("expected many"),
    }
}

#[test]
fn a_json_encoded_string_cell_contains_the_requested_member() {
    let r = row(&json!({"tags":"[\"a\",\"b\"]"}));
    assert!(
        matches_filter(
            &r,
            &Filter::Contains {
                column: "tags".into(),
                value: json!(["a"])
            }
        )
        .unwrap()
    );
}

#[test]
fn single_cardinality_over_zero_rows_is_refused_with_the_row_count() {
    let plan = QueryPlan {
        cardinality: "single".into(),
        ..Default::default()
    };
    let err = apply_query(vec![], &plan).unwrap_err();
    assert_eq!(err, QueryError::SingleCardinality(0));
}

#[test]
fn default_plan_is_many() {
    assert_eq!(QueryPlan::default().cardinality, "many");
    let out = apply_query(vec![row(&json!({"id":"p1"}))], &QueryPlan::default()).unwrap();
    assert!(matches!(out, QueryResult::Many(rows) if rows.len() == 1));
}

/// `deny_unknown_fields` on the internally tagged enum: a misspelled key is a
/// deserialization failure, not a node evaluated with a default.
#[test]
fn an_unknown_filter_key_is_refused() {
    let ok = r#"{"kind":"eq","column":"id","value":"p1"}"#;
    assert!(serde_json::from_str::<Filter>(ok).is_ok());
    let typo = r#"{"kind":"eq","column":"id","value":"p1","valeu":"p1"}"#;
    assert!(serde_json::from_str::<Filter>(typo).is_err());
}

/// The wire key is `nullsFirst`; the `snake_case` spelling is refused rather
/// than dropped into the default.
#[test]
fn the_order_key_is_camel_case_and_closed() {
    let camel = r#"{"column":"rank","ascending":false,"nullsFirst":true}"#;
    let parsed: OrderBy = serde_json::from_str(camel).unwrap();
    assert_eq!(parsed.nulls_first, Some(true));

    let snake = r#"{"column":"rank","ascending":false,"nulls_first":true}"#;
    assert!(serde_json::from_str::<OrderBy>(snake).is_err());
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        json!({"column":"rank","ascending":false,"nullsFirst":true})
    );
}

#[test]
fn an_unknown_plan_key_is_refused() {
    let typo = r#"{"filters":[],"limmit":1}"#;
    assert!(serde_json::from_str::<QueryPlan>(typo).is_err());
}

/// The wire key is `includeDeleted`, it defaults to excluding the marked
/// rows, and the `snake_case` spelling is refused rather than dropped into
/// that default: a plan asking for deleted rows under the wrong name would
/// otherwise answer with the ones it asked to see excluded.
#[test]
fn the_include_deleted_key_is_camel_case_and_closed() {
    let camel: QueryPlan = serde_json::from_str(r#"{"includeDeleted":true}"#).unwrap();
    assert!(camel.include_deleted);
    assert!(!QueryPlan::default().include_deleted);
    assert!(serde_json::from_str::<QueryPlan>(r#"{"include_deleted":true}"#).is_err());
    assert_eq!(
        serde_json::to_value(QueryPlan::default()).unwrap()["includeDeleted"],
        json!(false)
    );
}

#[test]
fn a_negative_limit_is_refused() {
    let plan = QueryPlan {
        limit: Some(-1),
        ..Default::default()
    };
    let err = apply_query(vec![row(&json!({"id":"p1"}))], &plan).unwrap_err();
    assert!(matches!(err, QueryError::Unsupported(_)), "{err}");
}

#[test]
fn an_unknown_text_search_type_is_refused() {
    let filters = vec![Filter::TextSearch {
        column: "title".into(),
        query: "alpha".into(),
        r#type: "phrsae".into(),
    }];
    let err = validate_filters(&filters).unwrap_err();
    assert!(matches!(err, QueryError::Unsupported(_)), "{err}");
    for known in ["plain", "phrase", "websearch"] {
        validate_filters(&[Filter::TextSearch {
            column: "title".into(),
            query: "alpha".into(),
            r#type: known.into(),
        }])
        .unwrap();
    }
}

#[test]
fn a_string_is_operand_is_refused() {
    let err = validate_filters(&[Filter::Is {
        column: "title".into(),
        value: json!("x"),
    }])
    .unwrap_err();
    assert!(matches!(err, QueryError::Unsupported(_)), "{err}");
    validate_filters(&[Filter::Is {
        column: "title".into(),
        value: Value::Null,
    }])
    .unwrap();
    validate_filters(&[Filter::Is {
        column: "done".into(),
        value: json!(true),
    }])
    .unwrap();
}

/// A child of `or`/`and`/`not` is refused exactly like a root filter.
#[test]
fn validation_walks_into_clause_children() {
    let nested = Filter::Not {
        filter: Box::new(Filter::Or {
            filters: vec![Filter::Is {
                column: "title".into(),
                value: json!("x"),
            }],
        }),
    };
    assert!(matches!(
        validate_filters(&[nested]).unwrap_err(),
        QueryError::Unsupported(_)
    ));
}

#[test]
fn a_projection_embed_or_rename_is_refused() {
    for entry in ["author(name)", "title:name"] {
        let plan = QueryPlan {
            projection: Some(vec![entry.to_string()]),
            ..Default::default()
        };
        let err = apply_query(vec![row(&json!({"id":"p1"}))], &plan).unwrap_err();
        assert!(matches!(err, QueryError::Unsupported(_)), "{entry}: {err}");
    }
}

/// An embed names a foreign-key join, and the refusal says why there is none
/// to follow and what to do instead.
#[test]
fn an_embed_refusal_names_the_missing_join_and_the_second_query() {
    let plan = QueryPlan {
        projection: Some(vec!["id".into(), "author(name)".into()]),
        ..Default::default()
    };
    let message = apply_query(vec![row(&json!({"id":"p1"}))], &plan)
        .unwrap_err()
        .to_string();
    assert!(message.contains("author(name)"), "{message}");
    assert!(message.contains("without foreign-key joins"), "{message}");
    assert!(message.contains("second query"), "{message}");
}

#[test]
fn an_empty_projection_segment_is_dropped() {
    let plan = QueryPlan {
        projection: Some(vec!["title".into(), " ".into()]),
        ..Default::default()
    };
    let out = apply_query(vec![row(&json!({"id":"p1","title":"Alpha"}))], &plan).unwrap();
    match out {
        QueryResult::Many(rows) => {
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0], row(&json!({"title":"Alpha"})));
        }
        other => panic!("expected many, got {other:?}"),
    }
}

/// The store round-trips a server-rendered `3.0` as a float; `eq`, `neq`, `in`
/// and the scalar containment case address a number by value, not by variant.
#[test]
fn an_integer_operand_matches_a_float_with_a_zero_fraction() {
    let r = row(&json!({"id":"p1","rank":3.0}));
    assert!(
        matches_filter(
            &r,
            &Filter::Eq {
                column: "rank".into(),
                value: json!(3)
            }
        )
        .unwrap()
    );
    assert!(
        !matches_filter(
            &r,
            &Filter::Neq {
                column: "rank".into(),
                value: json!(3)
            }
        )
        .unwrap()
    );
    assert!(
        matches_filter(
            &r,
            &Filter::In {
                column: "rank".into(),
                values: vec![json!(3)]
            }
        )
        .unwrap()
    );
    assert!(
        matches_filter(
            &r,
            &Filter::Contains {
                column: "rank".into(),
                value: json!(3)
            }
        )
        .unwrap()
    );
}

#[test]
fn a_float_with_a_zero_fraction_renders_without_the_fraction() {
    let r = row(&json!({"id":"p1","rank":3.0}));
    assert!(
        matches_filter(
            &r,
            &Filter::Like {
                column: "rank".into(),
                pattern: "3".into()
            }
        )
        .unwrap()
    );
    assert_eq!(
        value_as_search_text(Some(&json!(3.0))).as_deref(),
        Some("3")
    );
    assert_eq!(
        value_as_search_text(Some(&json!(3.5))).as_deref(),
        Some("3.5")
    );
    assert_eq!(
        value_as_search_text(Some(&json!(-0.0))).as_deref(),
        Some("0")
    );
}

#[test]
fn unknown_cardinality_fails_loud() {
    let plan = QueryPlan {
        cardinality: "sinlge".into(),
        ..Default::default()
    };
    let err = apply_query(vec![row(&json!({"id":"p1"}))], &plan).unwrap_err();
    assert_eq!(err, QueryError::InvalidCardinality("sinlge".into()));
}

// MARK: - Offset

/// Rows whose `rank` is the number in their id, in the order given.
fn ranked(order: &[u8]) -> Vec<Row> {
    order
        .iter()
        .map(|rank| row(&json!({"id": format!("p{rank}"), "rank": rank})))
        .collect()
}

fn ids(result: &QueryResult) -> Vec<String> {
    let rows: Vec<&Row> = match result {
        QueryResult::Many(rows) => rows.iter().collect(),
        QueryResult::One(row) => vec![row],
        QueryResult::Maybe(row) => row.iter().collect(),
        QueryResult::Counted { rows, .. } => return ids(rows),
    };
    rows.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn by_rank() -> Vec<OrderBy> {
    vec![OrderBy {
        column: "rank".into(),
        ascending: true,
        nulls_first: None,
    }]
}

/// Skipping before the filter, before the sort, or after the limit would each
/// answer a different pair.
#[test]
fn an_offset_skips_filtered_sorted_rows_before_the_limit_caps_the_rest() {
    let plan = QueryPlan {
        filters: vec![Filter::Gte {
            column: "rank".into(),
            value: json!(2),
        }],
        orders: by_rank(),
        offset: Some(1),
        limit: Some(2),
        ..Default::default()
    };
    let out = apply_query(ranked(&[4, 2, 5, 1, 3]), &plan).unwrap();
    assert_eq!(ids(&out), ["p3", "p4"]);

    let uncapped = QueryPlan {
        limit: None,
        ..plan
    };
    let out = apply_query(ranked(&[4, 2, 5, 1, 3]), &uncapped).unwrap();
    assert_eq!(ids(&out), ["p3", "p4", "p5"]);
}

#[test]
fn an_offset_past_the_end_answers_no_rows() {
    for offset in [3, 4, i64::MAX] {
        let plan = QueryPlan {
            offset: Some(offset),
            ..Default::default()
        };
        let out = apply_query(ranked(&[1, 2, 3]), &plan).unwrap();
        assert_eq!(out, QueryResult::Many(Vec::new()), "offset {offset}");
    }
}

#[test]
fn a_negative_offset_is_refused() {
    let plan = QueryPlan {
        offset: Some(-1),
        ..Default::default()
    };
    let err = apply_query(vec![row(&json!({"id":"p1"}))], &plan).unwrap_err();
    assert!(matches!(err, QueryError::Unsupported(_)), "{err}");
}

#[test]
fn single_and_maybe_single_count_only_the_rows_past_the_offset() {
    let plan = |cardinality: &str, offset: i64, limit: Option<i64>| QueryPlan {
        orders: by_rank(),
        offset: Some(offset),
        limit,
        cardinality: cardinality.into(),
        ..Default::default()
    };
    let rows = || ranked(&[3, 1, 2]);

    let last = apply_query(rows(), &plan("single", 2, None)).unwrap();
    assert_eq!(ids(&last), ["p3"]);
    let capped = apply_query(rows(), &plan("single", 1, Some(1))).unwrap();
    assert_eq!(ids(&capped), ["p2"]);
    assert_eq!(
        apply_query(rows(), &plan("single", 3, None)).unwrap_err(),
        QueryError::SingleCardinality(0)
    );
    assert_eq!(
        apply_query(rows(), &plan("single", 1, None)).unwrap_err(),
        QueryError::SingleCardinality(2)
    );

    assert_eq!(
        apply_query(rows(), &plan("maybeSingle", 3, None)).unwrap(),
        QueryResult::Maybe(None)
    );
    let last = apply_query(rows(), &plan("maybeSingle", 2, None)).unwrap();
    assert_eq!(ids(&last), ["p3"]);
    assert_eq!(
        apply_query(rows(), &plan("maybeSingle", 1, None)).unwrap_err(),
        QueryError::MaybeSingleCardinality(2)
    );
}

/// The wire key is `offset`, and a plan that leaves it out skips no row.
#[test]
fn the_offset_key_is_optional() {
    let parsed: QueryPlan = serde_json::from_str(r#"{"offset":2,"limit":3}"#).unwrap();
    assert_eq!((parsed.offset, parsed.limit), (Some(2), Some(3)));
    assert_eq!(QueryPlan::default().offset, None);
    assert_eq!(
        serde_json::from_str::<QueryPlan>("{}").unwrap(),
        QueryPlan::default()
    );
}

/// A caller that stops at the decisive matches must still hold the rows the
/// offset skips, or the window it hands the evaluator starts too early.
#[test]
fn the_rows_an_offset_skips_count_toward_the_decisive_matches() {
    let plan = |offset: i64, limit: Option<i64>, cardinality: &str| QueryPlan {
        offset: Some(offset),
        limit,
        cardinality: cardinality.into(),
        ..Default::default()
    };

    assert_eq!(plan(3, Some(2), "many").decisive_matches(), Some(5));
    assert_eq!(plan(3, None, "single").decisive_matches(), Some(5));
    assert_eq!(plan(3, Some(1), "maybeSingle").decisive_matches(), Some(4));
    assert_eq!(plan(0, Some(2), "many").decisive_matches(), Some(2));
    assert_eq!(
        plan(3, None, "many").decisive_matches(),
        None,
        "every match past the offset is part of the answer"
    );
    assert_eq!(plan(-1, Some(2), "many").decisive_matches(), None);

    let ordered = QueryPlan {
        orders: by_rank(),
        ..plan(1, Some(1), "many")
    };
    assert_eq!(ordered.decisive_matches(), None);
}

// MARK: - Key conjuncts

fn key_eq(value: Value) -> Filter {
    Filter::Eq {
        column: "id".into(),
        value,
    }
}

/// Every operand comes back as the filter wrote it, whatever its JSON type:
/// which ones name a row is the caller's to decide from its key's text rule.
#[test]
fn a_key_conjunct_hands_back_every_operand_as_written() {
    let operands = [
        json!("p1"),
        json!(7),
        json!(-7),
        json!(9_007_199_254_740_993_u64),
        json!(7.0),
        json!(1.5),
        Value::Null,
        json!(true),
        json!([1]),
        json!({"a": 1}),
    ];
    for operand in &operands {
        assert_eq!(
            conjunct_keys(&[key_eq(operand.clone())], "id"),
            Some(vec![operand]),
            "{operand}"
        );
    }

    let listed = [Filter::In {
        column: "id".into(),
        values: operands.to_vec(),
    }];
    assert_eq!(
        conjunct_keys(&listed, "id"),
        Some(operands.iter().collect())
    );
}

/// Only a conjunct restricts the rows: a filter of the list itself or a child
/// of an `and` at any depth, and the first one wins. A key filter under `or`
/// or `not`, or on another column, restricts nothing, and an empty `in`
/// restricts to no row at all.
#[test]
fn only_a_key_conjunct_restricts_the_rows() {
    let nested = [
        Filter::Gt {
            column: "rank".into(),
            value: json!(1),
        },
        Filter::And {
            filters: vec![Filter::And {
                filters: vec![key_eq(json!(7)), key_eq(json!("p2"))],
            }],
        },
    ];
    assert_eq!(conjunct_keys(&nested, "id"), Some(vec![&json!(7)]));

    let either = [Filter::Or {
        filters: vec![key_eq(json!("p1"))],
    }];
    assert_eq!(conjunct_keys(&either, "id"), None);
    let negated = [Filter::Not {
        filter: Box::new(key_eq(json!("p1"))),
    }];
    assert_eq!(conjunct_keys(&negated, "id"), None);
    assert_eq!(conjunct_keys(&[key_eq(json!("p1"))], "slug"), None);

    let empty = [Filter::In {
        column: "id".into(),
        values: vec![],
    }];
    assert_eq!(conjunct_keys(&empty, "id"), Some(Vec::new()));
}

// MARK: - Three-valued logic

/// The SQL truth value of `filter` on `row`, read through the only answer the
/// evaluator gives (whether the row matches): a predicate is true when it
/// matches, false when its negation matches, and unknown when neither does.
fn truth(row: &Row, filter: &Filter) -> Option<bool> {
    let holds = matches_filter(row, filter).unwrap();
    let negation_holds = matches_filter(
        row,
        &Filter::Not {
            filter: Box::new(filter.clone()),
        },
    )
    .unwrap();
    assert!(
        !(holds && negation_holds),
        "{filter:?} and its negation both matched"
    );
    if holds {
        Some(true)
    } else if negation_holds {
        Some(false)
    } else {
        None
    }
}

fn eq(column: &str, value: Value) -> Filter {
    Filter::Eq {
        column: column.into(),
        value,
    }
}

fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

fn or(filters: Vec<Filter>) -> Filter {
    Filter::Or { filters }
}

/// `one` is 1 and `gap` is null, so `eq(one, 1)` is true, `eq(one, 2)` is false
/// and `eq(gap, 1)` is unknown.
fn truth_row() -> Row {
    row(&json!({"id":"r1","one":1,"gap":null}))
}

#[test]
fn and_follows_the_sql_truth_table() {
    let r = truth_row();
    let (t, f, u) = (
        eq("one", json!(1)),
        eq("one", json!(2)),
        eq("gap", json!(1)),
    );
    assert_eq!(truth(&r, &u), None);
    assert_eq!(truth(&r, &and(vec![t.clone(), t.clone()])), Some(true));
    assert_eq!(truth(&r, &and(vec![t.clone(), f.clone()])), Some(false));
    assert_eq!(truth(&r, &and(vec![t.clone(), u.clone()])), None);
    assert_eq!(truth(&r, &and(vec![u.clone(), f.clone()])), Some(false));
    assert_eq!(truth(&r, &and(vec![f, u.clone()])), Some(false));
    assert_eq!(truth(&r, &and(vec![u.clone(), u])), None);
    assert_eq!(truth(&r, &and(vec![])), Some(true));
    assert_eq!(truth(&r, &and(vec![t])), Some(true));
}

#[test]
fn or_follows_the_sql_truth_table() {
    let r = truth_row();
    let (t, f, u) = (
        eq("one", json!(1)),
        eq("one", json!(2)),
        eq("gap", json!(1)),
    );
    assert_eq!(truth(&r, &or(vec![f.clone(), f.clone()])), Some(false));
    assert_eq!(truth(&r, &or(vec![f.clone(), t.clone()])), Some(true));
    assert_eq!(truth(&r, &or(vec![u.clone(), t.clone()])), Some(true));
    assert_eq!(truth(&r, &or(vec![t, u.clone()])), Some(true));
    assert_eq!(truth(&r, &or(vec![f.clone(), u.clone()])), None);
    assert_eq!(truth(&r, &or(vec![u.clone(), u])), None);
    assert_eq!(truth(&r, &or(vec![])), Some(false));
    assert_eq!(truth(&r, &or(vec![f])), Some(false));
}

#[test]
fn not_of_unknown_is_unknown_at_any_depth() {
    let r = truth_row();
    let unknown = or(vec![eq("one", json!(2)), eq("gap", json!(1))]);
    let twice = Filter::Not {
        filter: Box::new(Filter::Not {
            filter: Box::new(unknown.clone()),
        }),
    };
    assert_eq!(truth(&r, &unknown), None);
    assert_eq!(truth(&r, &twice), None);
    assert!(
        !matches_filter(&r, &twice).unwrap(),
        "only a true predicate selects a row"
    );
}

#[test]
fn eq_and_neq_with_a_null_operand_match_no_row() {
    for cells in [
        json!({"id":"r1","note":null}),
        json!({"id":"r2","note":"hi"}),
        json!({"id":"r3"}),
    ] {
        let r = row(&cells);
        assert_eq!(truth(&r, &eq("note", Value::Null)), None, "{cells}");
        let neq = Filter::Neq {
            column: "note".into(),
            value: Value::Null,
        };
        assert_eq!(truth(&r, &neq), None, "{cells}");
    }
}

/// Every comparison reads a null cell and an absent column as unknown, so the
/// row is dropped by the comparison and by its negation alike.
#[test]
fn a_comparison_with_a_null_or_absent_cell_is_unknown() {
    let comparisons = vec![
        eq("c", json!("x")),
        Filter::Neq {
            column: "c".into(),
            value: json!("x"),
        },
        Filter::Gt {
            column: "c".into(),
            value: json!(1),
        },
        Filter::Gte {
            column: "c".into(),
            value: json!(1),
        },
        Filter::Lt {
            column: "c".into(),
            value: json!(1),
        },
        Filter::Lte {
            column: "c".into(),
            value: json!(1),
        },
        Filter::Like {
            column: "c".into(),
            pattern: "%".into(),
        },
        Filter::Ilike {
            column: "c".into(),
            pattern: "x%".into(),
        },
        Filter::In {
            column: "c".into(),
            values: vec![json!("x")],
        },
        Filter::Contains {
            column: "c".into(),
            value: json!(["x"]),
        },
        Filter::ContainedBy {
            column: "c".into(),
            value: json!(["x"]),
        },
        Filter::TextSearch {
            column: "c".into(),
            query: "x".into(),
            r#type: "plain".into(),
        },
        Filter::TextSearch {
            column: "c".into(),
            query: " ".into(),
            r#type: "plain".into(),
        },
        Filter::Search {
            query: "x".into(),
            columns: Some(vec!["c".into()]),
        },
        regex_match("c", "x"),
        regex_imatch("c", "."),
        overlaps("c", json!(["x"])),
    ];
    for cells in [json!({"id":"r1","c":null}), json!({"id":"r2"})] {
        let r = row(&cells);
        for comparison in &comparisons {
            assert_eq!(truth(&r, comparison), None, "{comparison:?} on {cells}");
        }
    }
}

#[test]
fn a_range_or_containment_operand_of_null_is_unknown() {
    let r = row(&json!({"id":"r1","c":3,"tags":["a"]}));
    for filter in [
        Filter::Gt {
            column: "c".into(),
            value: Value::Null,
        },
        Filter::Lte {
            column: "c".into(),
            value: Value::Null,
        },
        Filter::Contains {
            column: "tags".into(),
            value: Value::Null,
        },
        Filter::ContainedBy {
            column: "tags".into(),
            value: Value::Null,
        },
        overlaps("tags", Value::Null),
    ] {
        assert_eq!(truth(&r, &filter), None, "{filter:?}");
    }
}

/// `x IN (…, NULL)` is true on a member and unknown otherwise, so `NOT IN` with a
/// null member drops every row; an empty list is false even for a null cell, as
/// `= ANY('{}')` is.
#[test]
fn in_follows_sql_membership() {
    let with_null = |column: &str| Filter::In {
        column: column.into(),
        values: vec![json!("hi"), Value::Null],
    };
    let r = row(&json!({"id":"r1","hit":"hi","miss":"no","gap":null}));
    assert_eq!(truth(&r, &with_null("hit")), Some(true));
    assert_eq!(truth(&r, &with_null("miss")), None);
    assert_eq!(truth(&r, &with_null("gap")), None);
    for column in ["hit", "gap", "absent"] {
        let empty = Filter::In {
            column: column.into(),
            values: vec![],
        };
        assert_eq!(truth(&r, &empty), Some(false), "{column}");
    }
}

/// `is` answers true or false on every row and folds an absent column into null.
#[test]
fn is_is_never_unknown() {
    let is = |column: &str, value: Value| Filter::Is {
        column: column.into(),
        value,
    };
    let r = row(&json!({"id":"r1","gap":null,"done":true,"text":"x"}));
    assert_eq!(truth(&r, &is("gap", Value::Null)), Some(true));
    assert_eq!(truth(&r, &is("absent", Value::Null)), Some(true));
    assert_eq!(truth(&r, &is("done", Value::Null)), Some(false));
    assert_eq!(truth(&r, &is("done", json!(true))), Some(true));
    assert_eq!(truth(&r, &is("gap", json!(false))), Some(false));
    assert_eq!(truth(&r, &is("absent", json!(true))), Some(false));
    assert_eq!(truth(&r, &is("text", json!(true))), Some(false));
}

/// A present cell that is not text keeps a known answer: a pattern or a text
/// search over an array or an object is false, never unknown, and the default
/// search columns skip null cells rather than reading them as unknown.
#[test]
fn a_present_cell_keeps_a_known_answer() {
    let r = row(&json!({"id":"r1","tags":["a"],"meta":{"k":1},"gap":null}));
    for column in ["tags", "meta"] {
        let like = Filter::Like {
            column: column.into(),
            pattern: "%".into(),
        };
        assert_eq!(truth(&r, &like), Some(false), "{column}");
        let text = Filter::TextSearch {
            column: column.into(),
            query: "a".into(),
            r#type: "plain".into(),
        };
        assert_eq!(truth(&r, &text), Some(false), "{column}");
    }
    let everywhere = Filter::Search {
        query: "zz".into(),
        columns: None,
    };
    assert_eq!(truth(&r, &everywhere), Some(false));
    let blank = Filter::Search {
        query: " ".into(),
        columns: Some(vec!["gap".into()]),
    };
    assert_eq!(truth(&r, &blank), Some(true));
    let partly = Filter::Search {
        query: "r1".into(),
        columns: Some(vec!["gap".into(), "id".into()]),
    };
    assert_eq!(truth(&r, &partly), Some(true));
}

// MARK: - Like wildcards and per-query builds

fn like(column: &str, pattern: &str) -> Filter {
    Filter::Like {
        column: column.into(),
        pattern: pattern.into(),
    }
}

fn ilike(column: &str, pattern: &str) -> Filter {
    Filter::Ilike {
        column: column.into(),
        pattern: pattern.into(),
    }
}

fn titled(title: &str) -> Row {
    row(&json!({"id": "t", "title": title}))
}

fn builds() -> usize {
    crate::eval::BUILDS.with(std::cell::Cell::get)
}

fn reset_builds() {
    crate::eval::BUILDS.with(|builds| builds.set(0));
}

const fn assert_send<T: Send>() {}

#[test]
fn a_star_in_a_like_pattern_spans_any_run_as_percent_does() {
    for (pattern, title, expected) in [
        ("*plane*", "works on a plane", true),
        ("works*", "works on a plane", true),
        ("*", "", true),
        ("a*c", "abbbc", true),
        ("a*c", "abd", false),
        ("a**", "a", true),
        ("*%_", "x", true),
        ("a\\*c", "a*c", true),
        ("a\\*c", "abc", false),
    ] {
        assert_eq!(
            matches_filter(&titled(title), &like("title", pattern)).unwrap(),
            expected,
            "{pattern} on {title:?}"
        );
    }
    assert!(matches_filter(&titled("Works On A Plane"), &ilike("title", "*PLANE")).unwrap());
    assert!(!matches_filter(&titled("Works On A Plane"), &like("title", "*PLANE")).unwrap());
    assert_eq!(truth(&row(&json!({"id": "t"})), &like("title", "*")), None);
}

#[test]
fn a_query_builds_each_pattern_and_search_once_however_many_rows_it_reads() {
    let rows: Vec<Row> = (0..40)
        .map(|i| {
            row(&json!({"id": format!("r{i}"), "title": format!("alpha beta {i}"), "done": false}))
        })
        .collect();
    let plan = QueryPlan {
        filters: vec![
            like("title", "alpha%"),
            ilike("title", "%BETA%"),
            Filter::TextSearch {
                column: "title".into(),
                query: "\"alpha beta\" 1".into(),
                r#type: "websearch".into(),
            },
        ],
        ..QueryPlan::default()
    };

    reset_builds();
    let QueryResult::Many(matched) = apply_query(rows.clone(), &plan).unwrap() else {
        panic!("expected many");
    };
    assert_eq!(matched.len(), 13);
    assert_eq!(
        builds(),
        3,
        "one regex per pattern and one parse per search"
    );

    // A node no row reaches builds nothing.
    let unreached = QueryPlan {
        filters: vec![eq("done", json!(true)), like("title", "alpha%")],
        ..QueryPlan::default()
    };
    reset_builds();
    let QueryResult::Many(none) = apply_query(rows, &unreached).unwrap() else {
        panic!("expected many");
    };
    assert!(none.is_empty());
    assert_eq!(builds(), 0);
}

#[test]
fn one_predicate_builds_once_across_rows_and_answers_as_matches_filters() {
    let rows: Vec<Row> = [
        json!({"id": "a", "title": "alpha beta", "note": null}),
        json!({"id": "b", "title": "beta", "note": "x"}),
        json!({"id": "c", "title": null}),
        json!({"id": "d", "title": ["alpha"]}),
    ]
    .iter()
    .map(row)
    .collect();
    let filters = vec![or(vec![
        like("title", "*alpha*"),
        Filter::Not {
            filter: Box::new(Filter::TextSearch {
                column: "title".into(),
                query: "\"beta\"".into(),
                r#type: "websearch".into(),
            }),
        },
    ])];

    reset_builds();
    let predicate = Predicate::new(&filters);
    let answers: Vec<bool> = rows.iter().map(|r| predicate.matches(r).unwrap()).collect();
    assert_eq!(builds(), 2);
    assert_eq!(answers, [true, false, false, true]);
    for (r, answer) in rows.iter().zip(answers) {
        assert_eq!(matches_filters(r, &filters).unwrap(), answer);
    }
    assert_send::<Predicate<'static>>();
}

// MARK: - Regex match

fn regex_match(column: &str, pattern: &str) -> Filter {
    Filter::RegexMatch {
        column: column.into(),
        pattern: pattern.into(),
    }
}

fn regex_imatch(column: &str, pattern: &str) -> Filter {
    Filter::RegexIMatch {
        column: column.into(),
        pattern: pattern.into(),
    }
}

/// Postgres `~` searches anywhere in the text unless the pattern anchors it,
/// and `~*` is the same search without case.
#[test]
fn regex_match_searches_the_cell_text_and_imatch_ignores_case() {
    for (pattern, title, expected) in [
        ("plane", "works on a plane", true),
        ("^works", "works on a plane", true),
        ("plane$", "works on a plane", true),
        ("^plane", "works on a plane", false),
        ("p[lk]ane", "works on a plane", true),
        ("Works", "works on a plane", false),
        ("^\\d+$", "42", true),
        ("a{2}", "aardvark", true),
    ] {
        assert_eq!(
            matches_filter(&titled(title), &regex_match("title", pattern)).unwrap(),
            expected,
            "{pattern} on {title:?}"
        );
    }
    assert!(
        matches_filter(
            &titled("Works On A Plane"),
            &regex_imatch("title", "^works.*PLANE$")
        )
        .unwrap()
    );
    assert!(!matches_filter(&titled("Works On A Plane"), &regex_match("title", "^works")).unwrap());
}

/// A number or a boolean cell is matched through its text form, as `like` reads
/// it; an array or an object has none, so the match is false, not unknown.
#[test]
fn a_regex_reads_scalar_text_and_is_false_on_an_array_or_an_object() {
    let r = row(&json!({"id":"r1","rank":3.0,"done":true,"tags":["a"],"meta":{"k":"a"}}));
    assert_eq!(truth(&r, &regex_match("rank", "^3$")), Some(true));
    assert_eq!(truth(&r, &regex_imatch("done", "TRUE")), Some(true));
    for column in ["tags", "meta"] {
        assert_eq!(
            truth(&r, &regex_match(column, "a")),
            Some(false),
            "{column}"
        );
        assert_eq!(
            truth(&r, &regex_imatch(column, "a")),
            Some(false),
            "{column}"
        );
    }
}

#[test]
fn a_pattern_the_regex_engine_cannot_compile_is_unsupported_and_named() {
    for pattern in ["(a)\\1", "(?=a)b", "(?<!a)b", "(unclosed"] {
        for filter in [
            regex_match("title", pattern),
            regex_imatch("title", pattern),
        ] {
            let err = matches_filter(&titled("ab"), &filter).unwrap_err();
            match err {
                QueryError::Unsupported(message) => {
                    assert!(message.contains(pattern), "{message}");
                }
                other => panic!("{pattern}: expected Unsupported, got {other:?}"),
            }
        }
    }
}

#[test]
fn a_query_compiles_each_regex_once_however_many_rows_it_reads() {
    let rows: Vec<Row> = (0..40)
        .map(|i| row(&json!({"id": format!("r{i}"), "title": format!("alpha {i}")})))
        .collect();
    let plan = QueryPlan {
        filters: vec![
            regex_match("title", "^alpha \\d$"),
            regex_imatch("title", "ALPHA"),
        ],
        ..QueryPlan::default()
    };

    reset_builds();
    let QueryResult::Many(matched) = apply_query(rows, &plan).unwrap() else {
        panic!("expected many");
    };
    assert_eq!(matched.len(), 10);
    assert_eq!(builds(), 2, "one regex per pattern");
}

/// Wire kinds `regexMatch` and `regexIMatch`, closed like every node.
#[test]
fn the_regex_kinds_are_camel_case() {
    let parsed: Filter =
        serde_json::from_str(r#"{"kind":"regexIMatch","column":"title","pattern":"^a"}"#).unwrap();
    assert_eq!(parsed, regex_imatch("title", "^a"));
    assert_eq!(
        serde_json::to_value(regex_match("title", "^a")).unwrap(),
        json!({"kind":"regexMatch","column":"title","pattern":"^a"})
    );
}

// MARK: - Is distinct

fn is_distinct(column: &str, value: Value) -> Filter {
    Filter::IsDistinct {
        column: column.into(),
        value,
    }
}

/// `IS DISTINCT FROM`: true when exactly one side is null or both are present
/// and unequal, and never unknown, so it is the inequality that keeps null rows.
#[test]
fn is_distinct_is_null_safe_inequality_and_never_unknown() {
    let r = row(&json!({"id":"r1","one":1,"gap":null,"text":"x"}));
    for (column, value, expected) in [
        ("one", json!(1), false),
        ("one", json!(1.0), false),
        ("one", json!(2), true),
        ("one", Value::Null, true),
        ("gap", Value::Null, false),
        ("absent", Value::Null, false),
        ("gap", json!(1), true),
        ("absent", json!("x"), true),
        ("text", json!("x"), false),
        ("text", json!("y"), true),
    ] {
        assert_eq!(
            truth(&r, &is_distinct(column, value.clone())),
            Some(expected),
            "{column} is distinct from {value}"
        );
    }
    assert_eq!(
        serde_json::to_value(is_distinct("one", json!(1))).unwrap(),
        json!({"kind":"isDistinct","column":"one","value":1})
    );
}

// MARK: - Overlaps

fn overlaps(column: &str, value: Value) -> Filter {
    Filter::Overlaps {
        column: column.into(),
        value,
    }
}

/// Postgres `&&`: the cell array and the operand share an element. A cell
/// holding JSON array text is decoded as `contains` decodes it.
#[test]
fn overlaps_is_true_when_the_cell_array_shares_an_element() {
    let r = row(&json!({
        "id":"r1",
        "tags":["a","b"],
        "encoded":"[\"c\",\"d\"]",
        "scalar":"a",
        "empty":[]
    }));
    for (column, operand, expected) in [
        ("tags", json!(["b", "z"]), true),
        ("tags", json!(["z"]), false),
        ("tags", json!([]), false),
        ("tags", json!("[\"a\"]"), true),
        ("encoded", json!(["d"]), true),
        ("encoded", json!(["a"]), false),
        ("scalar", json!(["a"]), false),
        ("empty", json!(["a"]), false),
    ] {
        assert_eq!(
            truth(&r, &overlaps(column, operand.clone())),
            Some(expected),
            "{column} && {operand}"
        );
    }
    assert_eq!(
        serde_json::to_value(overlaps("tags", json!(["a"]))).unwrap(),
        json!({"kind":"overlaps","column":"tags","value":["a"]})
    );
}

/// A Postgres range literal has no local representation; any other operand
/// that is not an array names nothing to overlap with.
#[test]
fn an_overlaps_operand_that_is_not_an_array_is_refused_before_any_row() {
    for operand in [
        json!("[1,5)"),
        json!("(1,5]"),
        json!("[2020-01-01,2020-02-01)"),
        json!("{a,b}"),
        json!("a"),
        json!(3),
        json!({"k":"a"}),
    ] {
        let err = validate_filters(&[overlaps("tags", operand.clone())]).unwrap_err();
        assert!(
            matches!(err, QueryError::Unsupported(_)),
            "{operand}: {err}"
        );
    }
    let range = validate_filters(&[overlaps("tags", json!("[1,5)"))]).unwrap_err();
    assert!(range.to_string().contains("range"), "{range}");
    for operand in [
        json!(["a"]),
        json!("[\"a\",1]"),
        json!("[1,5]"),
        Value::Null,
    ] {
        validate_filters(&[overlaps("tags", operand)]).unwrap();
    }
}

// MARK: - Exact count

/// The count is every row the filters match, taken before the offset and the
/// limit cut the page, as a `PostgREST` exact count is.
#[test]
fn count_is_the_matches_before_the_offset_and_the_limit() {
    let plan = QueryPlan {
        filters: vec![Filter::Gte {
            column: "rank".into(),
            value: json!(2),
        }],
        orders: by_rank(),
        offset: Some(1),
        limit: Some(1),
        count: true,
        ..Default::default()
    };
    let out = apply_query(ranked(&[4, 2, 5, 1, 3]), &plan).unwrap();
    let QueryResult::Counted { rows, count } = &out else {
        panic!("expected a counted answer, got {out:?}");
    };
    assert_eq!(*count, 4);
    assert_eq!(ids(rows), ["p3"]);
    assert_eq!(ids(&out), ["p3"]);
}

#[test]
fn a_one_row_plan_counts_its_matches_too() {
    let single = QueryPlan {
        filters: vec![eq("id", json!("p2"))],
        cardinality: "single".into(),
        count: true,
        ..Default::default()
    };
    let out = apply_query(ranked(&[1, 2, 3]), &single).unwrap();
    assert!(
        matches!(&out, QueryResult::Counted { rows, count: 1 } if **rows == QueryResult::One(row(&json!({"id":"p2","rank":2})))),
        "{out:?}"
    );

    let none = QueryPlan {
        filters: vec![eq("id", json!("p9"))],
        cardinality: "maybeSingle".into(),
        count: true,
        ..Default::default()
    };
    let out = apply_query(ranked(&[1, 2, 3]), &none).unwrap();
    assert_eq!(
        out,
        QueryResult::Counted {
            rows: Box::new(QueryResult::Maybe(None)),
            count: 0
        }
    );

    let missing = QueryPlan {
        count: true,
        ..single
    };
    assert_eq!(
        apply_query(ranked(&[1, 3]), &missing).unwrap_err(),
        QueryError::SingleCardinality(0)
    );
}

/// The wire answer of a counted plan is `{"rows": …, "count": n}`; a plan that
/// asks for no count keeps the bare shape its cardinality names.
#[test]
fn a_counted_answer_carries_rows_beside_count_on_the_wire() {
    let counted = QueryPlan {
        projection: Some(vec!["id".into()]),
        count: true,
        ..Default::default()
    };
    let out = apply_query(ranked(&[2, 1]), &counted).unwrap();
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        json!({"rows": [{"id":"p2"}, {"id":"p1"}], "count": 2})
    );

    let plain = QueryPlan {
        count: false,
        ..counted
    };
    let out = apply_query(ranked(&[2, 1]), &plain).unwrap();
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        json!([{"id":"p2"}, {"id":"p1"}])
    );
}

/// The wire key is `count`, absent means no count, and a counted plan needs
/// every match, so no early stop can decide it.
#[test]
fn the_count_key_is_optional_and_a_counted_plan_reads_every_match() {
    let parsed: QueryPlan = serde_json::from_str(r#"{"count":true,"limit":2}"#).unwrap();
    assert!(parsed.count);
    assert!(!QueryPlan::default().count);
    assert_eq!(parsed.decisive_matches(), None);

    let uncounted = QueryPlan {
        count: false,
        ..parsed
    };
    assert_eq!(uncounted.decisive_matches(), Some(2));
}
