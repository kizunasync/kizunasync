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
        projection: None,
        cardinality: "many".into(),
        include_deleted: false,
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
