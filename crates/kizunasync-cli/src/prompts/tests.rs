use std::io::ErrorKind;

use crate::config::{MaxBatchSize, ProjectSettings};
use crate::proposals::ConflictMode;

use super::cliclack::project_hint;
use super::keys::io_error;
use super::*;

fn choices() -> Vec<TableChoice> {
    vec![
        TableChoice::new("todos", true)
            .labelled("todos")
            .with_hint("owner user_id · read-write"),
        TableChoice::new("notes", false),
    ]
}

fn candidates() -> Vec<ConnectionCandidate> {
    vec![
        ConnectionCandidate::Local {
            port: 54322,
            reachable: true,
        },
        ConnectionCandidate::Manual,
    ]
}

fn projects() -> Vec<ProjectSummary> {
    vec![
        ProjectSummary {
            project_ref: "aaaaaaaaaaaaaaaaaaaa".to_owned(),
            name: "prod".to_owned(),
            region: "eu-central-1".to_owned(),
        },
        ProjectSummary {
            project_ref: "bbbbbbbbbbbbbbbbbbbb".to_owned(),
            name: "staging".to_owned(),
            region: String::new(),
        },
    ]
}

#[test]
fn the_connection_picker_records_what_it_offered_and_answers_from_the_script() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Manual)]);

    assert_eq!(
        prompter.select_candidate(&candidates(), None).unwrap(),
        ConnectionCandidate::Manual
    );
    assert_eq!(
        prompter.asked(),
        [Ask::Candidate {
            candidates: candidates(),
            current: None,
        }]
    );
}

#[test]
fn one_candidate_or_none_resolves_without_consuming_an_answer() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let only = [ConnectionCandidate::Local {
        port: 54322,
        reachable: true,
    }];

    assert_eq!(prompter.select_candidate(&only, None).unwrap(), only[0]);
    assert_eq!(
        prompter.select_candidate(&[], None).unwrap(),
        ConnectionCandidate::Manual
    );
    assert_eq!(prompter.unused(), 1);
}

#[test]
fn a_candidate_that_was_never_offered_fails_loudly() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Candidate(ConnectionCandidate::Account)]);
    let error = prompter.select_candidate(&candidates(), None).unwrap_err();

    assert!(matches!(error, PromptError::Script(_)));
    assert!(error.to_string().contains("was not offered"));
}

#[test]
fn the_project_picker_answers_a_ref_and_refuses_one_it_never_listed() {
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Project("bbbbbbbbbbbbbbbbbbbb".to_owned()),
        Answer::Project("not-listed".to_owned()),
    ]);

    assert_eq!(
        prompter.select_project(&projects(), None).unwrap(),
        "bbbbbbbbbbbbbbbbbbbb"
    );
    let PromptError::Script(message) = prompter.select_project(&projects(), None).unwrap_err()
    else {
        panic!("a ref the picker never listed is a script failure");
    };
    assert!(message.contains("not-listed"), "{message}");
    assert_eq!(
        prompter.asked().first(),
        Some(&Ask::Project {
            projects: projects(),
            current: None,
        })
    );
}

#[test]
fn an_account_with_no_projects_needs_no_answer() {
    let mut prompter = ScriptedPrompter::default();

    assert_eq!(prompter.select_project(&[], None).unwrap(), "");
}

#[test]
fn a_phase_records_its_title_and_docs_url() {
    let mut prompter = ScriptedPrompter::default();

    prompter.phase(crate::docs::CONNECTION_PHASE).unwrap();

    assert_eq!(
        prompter.asked(),
        [Ask::Phase {
            title: crate::docs::CONNECTION_PHASE.title.to_owned(),
            docs: crate::docs::CONNECTION_PHASE.url.to_owned(),
        }]
    );
}

#[test]
fn a_pasted_access_token_is_trimmed_and_recorded_as_asked() {
    let mut prompter =
        ScriptedPrompter::new(vec![Answer::AccessToken("  sbp_pasted  ".to_owned())]);

    assert_eq!(prompter.ask_access_token().unwrap(), "sbp_pasted");
    assert_eq!(prompter.asked(), [Ask::AccessToken]);
}

#[test]
fn the_project_hint_carries_the_ref_and_drops_an_absent_region() {
    assert_eq!(
        project_hint(&projects()[0]),
        "aaaaaaaaaaaaaaaaaaaa · eu-central-1"
    );
    assert_eq!(project_hint(&projects()[1]), "bbbbbbbbbbbbbbbbbbbb");
}

#[test]
fn a_script_answers_the_three_questions_in_order() {
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::DbUrl("  postgres://local  ".to_owned()),
        Answer::Tables(vec!["todos".to_owned(), "notes".to_owned()]),
        Answer::Confirm(true),
    ]);

    assert_eq!(prompter.ask_db_url(None).unwrap(), "postgres://local");
    assert_eq!(
        prompter.select_tables(&choices()).unwrap(),
        ["todos", "notes"]
    );
    assert!(
        prompter
            .confirm("Apply 3 pack file(s) now?", false)
            .unwrap()
    );
    assert_eq!(prompter.unused(), 0);
}

#[test]
fn a_script_walks_recommended_then_customize() {
    let derived = TableProposal::derived("todos", Some("user_id"), "[auto]");
    let mut custom = derived.clone();
    custom.conflict = Some(ConflictMode::Hlc);
    // Every `_config` column the ladder asks about survives the scripted answer.
    custom.conflict_journal = true;
    custom.register_clients = true;
    custom.min_schema_version = Some(3);
    custom.tombstone_ttl_days = Some(7);
    custom.soft_delete = Some("deleted_at".to_owned());
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(custom.clone()),
    ]);

    assert_eq!(
        prompter.select_mode(WizardMode::Recommended).unwrap(),
        WizardMode::Customize
    );
    assert_eq!(prompter.customize_table(&derived, &[]).unwrap(), custom);
    assert_eq!(
        prompter.asked(),
        [
            Ask::Mode {
                current: WizardMode::Recommended
            },
            Ask::Customize {
                current: derived,
                entry: Entry::First,
            }
        ]
    );
}

/// The whole Customize walk, in order: the per-table ladder, then the three
/// server sections. A step the scripted backend does not mirror would make the
/// wizard untestable, which is the only place these sections are reachable.
#[test]
fn a_script_walks_every_server_section_after_the_table_ladder() {
    let derived = TableProposal::derived("todos", Some("user_id"), "[auto]");
    let maintenance = ProjectSettings {
        reap_schedule: Some("0 4 * * *".to_owned()),
        ..ProjectSettings::pack_defaults()
    };
    let both = ProjectSettings {
        max_batch_size: Some(MaxBatchSize::Mutations(25)),
        require_atomic: Some(true),
        ..maintenance.clone()
    };
    let push_only = ProjectSettings {
        max_batch_size: Some(MaxBatchSize::Mutations(25)),
        require_atomic: Some(true),
        ..ProjectSettings::default()
    };
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Mode(WizardMode::Customize),
        Answer::Customize(derived.clone()),
        Answer::Section(SectionChoice::Custom),
        Answer::Maintenance(maintenance.clone()),
        Answer::Section(SectionChoice::Custom),
        Answer::PushPolicy(push_only),
        Answer::CronPolicy(true),
    ]);

    assert_eq!(
        prompter.select_mode(WizardMode::Customize).unwrap(),
        WizardMode::Customize
    );
    assert_eq!(prompter.customize_table(&derived, &[]).unwrap(), derived);
    assert_eq!(
        prompter
            .select_section(
                ServerSection::Maintenance,
                &ProjectSettings::pack_defaults(),
                SectionChoice::Keep,
            )
            .unwrap(),
        SectionChoice::Custom
    );
    let answered = prompter
        .ask_maintenance(&ProjectSettings::pack_defaults(), Entry::First)
        .unwrap();
    assert_eq!(answered, maintenance);
    assert_eq!(
        prompter
            .select_section(ServerSection::PushPolicy, &answered, SectionChoice::Keep)
            .unwrap(),
        SectionChoice::Custom
    );
    assert_eq!(
        prompter.ask_push_policy(&answered).unwrap().max_batch_size,
        both.max_batch_size
    );
    assert!(prompter.ask_cron_policy(false).unwrap());
    assert_eq!(prompter.unused(), 0);
    assert_eq!(
        prompter.asked(),
        [
            Ask::Mode {
                current: WizardMode::Customize
            },
            Ask::Customize {
                current: derived,
                entry: Entry::First,
            },
            Ask::Section {
                section: ServerSection::Maintenance,
                current: ProjectSettings::pack_defaults(),
                choice: SectionChoice::Keep,
            },
            Ask::Maintenance {
                current: ProjectSettings::pack_defaults(),
                entry: Entry::First,
            },
            Ask::Section {
                section: ServerSection::PushPolicy,
                current: maintenance.clone(),
                choice: SectionChoice::Keep,
            },
            Ask::PushPolicy {
                current: maintenance
            },
            Ask::CronPolicy {
                allow_no_cron: false
            },
        ]
    );
}

/// A section's select answers only a keep-or-custom choice: values meant for
/// the inputs after it are a loud script failure.
#[test]
fn a_section_select_refuses_an_answer_meant_for_its_values() {
    let mut prompter =
        ScriptedPrompter::new(vec![Answer::PushPolicy(ProjectSettings::pack_defaults())]);
    let PromptError::Script(message) = prompter
        .select_section(
            ServerSection::PushPolicy,
            &ProjectSettings::default(),
            SectionChoice::Keep,
        )
        .unwrap_err()
    else {
        panic!("values meant for the inputs are a script failure at the select");
    };

    assert!(message.contains("Server push policy"), "{message}");
}

/// An answer meant for another step is a loud script failure, not an answer
/// applied to the wrong column.
#[test]
fn a_server_section_refuses_an_answer_meant_for_another_one() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::CronPolicy(true)]);
    let PromptError::Script(message) = prompter
        .ask_maintenance(&ProjectSettings::default(), Entry::First)
        .unwrap_err()
    else {
        panic!("an answer meant for another section is a script failure");
    };

    assert!(message.contains("Server maintenance"), "{message}");
}

#[test]
fn every_question_is_recorded_with_what_it_offered() {
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Tables(vec!["todos".to_owned()]),
        Answer::Confirm(false),
    ]);
    prompter.select_tables(&choices()).unwrap();
    prompter.confirm("Write migrations now?", false).unwrap();

    assert_eq!(
        prompter.asked(),
        [
            Ask::Tables { choices: choices() },
            Ask::Confirm {
                message: "Write migrations now?".to_owned(),
                default: false,
            },
        ]
    );
}

#[test]
fn the_already_synced_tables_arrive_pre_checked() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Tables(Vec::new())]);
    prompter.select_tables(&choices()).unwrap();
    let Some(Ask::Tables { choices: offered }) = prompter.asked().first() else {
        panic!("the tables question was not recorded");
    };

    assert_eq!(
        offered
            .iter()
            .filter(|choice| choice.checked)
            .map(|choice| choice.table.as_str())
            .collect::<Vec<_>>(),
        ["todos"]
    );
}

#[test]
fn a_missing_answer_fails_loudly_instead_of_blocking() {
    let mut prompter = ScriptedPrompter::default();
    let PromptError::Script(message) = prompter.confirm("Apply now?", false).unwrap_err() else {
        panic!("an exhausted script is a script failure");
    };

    assert!(message.contains("Apply now?"), "{message}");
}

#[test]
fn an_answer_of_the_wrong_kind_names_what_the_script_offered() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);
    let PromptError::Script(message) = prompter.select_tables(&choices()).unwrap_err() else {
        panic!("an answer of the wrong kind is a script failure");
    };

    assert!(message.contains("Confirm(true)"), "{message}");
}

#[test]
fn nothing_to_choose_from_resolves_without_consuming_an_answer() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Confirm(true)]);

    assert_eq!(prompter.select_tables(&[]).unwrap(), Vec::<String>::new());
    assert_eq!(prompter.unused(), 1);
}

#[test]
fn a_terminal_prompter_exists_exactly_when_stdin_is_one() {
    assert_eq!(CliclackPrompter::new().is_ok(), is_interactive());
}

#[test]
fn a_run_without_a_terminal_is_told_to_pass_flags() {
    // The whole sentence is the contract: it is what a piped run prints.
    assert_eq!(
        PromptError::NotInteractive.to_string(),
        "no terminal to prompt on: pass the flags instead"
    );
    assert!(matches!(
        io_error(&std::io::Error::from(ErrorKind::NotConnected)),
        PromptError::NotInteractive
    ));
}

#[test]
fn esc_and_ctrl_c_are_both_a_cancellation() {
    assert!(matches!(
        io_error(&std::io::Error::from(ErrorKind::Interrupted)),
        PromptError::Cancelled
    ));
}

#[test]
fn a_backend_failure_keeps_its_own_sentence() {
    let error = io_error(&std::io::Error::other("empty list"));

    assert_eq!(error.to_string(), "empty list");
}

fn panel_items() -> Vec<PanelItem> {
    vec![
        PanelItem {
            action: PanelAction::HealthCheck,
            label: "Health check".to_owned(),
            hint: "run every doctor check".to_owned(),
        },
        PanelItem {
            action: PanelAction::Exit,
            label: "Exit".to_owned(),
            hint: String::new(),
        },
    ]
}

#[test]
fn a_panel_select_records_what_it_offered_and_refuses_an_item_it_never_listed() {
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Action(PanelAction::Exit),
        Answer::Action(PanelAction::Status),
    ]);

    assert_eq!(
        prompter
            .select_action(
                "What do you want to do?",
                &panel_items(),
                None,
                BackKey::Honoured
            )
            .unwrap(),
        PanelAction::Exit
    );
    assert!(matches!(
        prompter.select_action("What do you want to do?", &panel_items(), None, BackKey::Honoured),
        Err(PromptError::Script(message)) if message.contains("Status was not offered")
    ));
    assert_eq!(
        prompter.asked()[0],
        Ask::Action {
            message: "What do you want to do?".to_owned(),
            items: panel_items(),
            current: None,
            back: BackKey::Honoured,
        }
    );
}

#[test]
fn backspace_on_a_panel_select_is_a_step_back() {
    let mut prompter = ScriptedPrompter::new(vec![Answer::Back]);

    assert!(matches!(
        prompter.select_action(
            "What do you want to do?",
            &panel_items(),
            None,
            BackKey::Honoured
        ),
        Err(PromptError::Back)
    ));
}

/// Only the exact target, surrounding spaces aside, confirms: a script can
/// answer anything else, and that answer is a refusal, not an error.
#[test]
fn a_typed_confirmation_answers_whether_the_text_is_the_target() {
    let mut prompter = ScriptedPrompter::new(vec![
        Answer::Typed(" local ".to_owned()),
        Answer::Typed("production".to_owned()),
        Answer::Typed("LOCAL".to_owned()),
        Answer::Confirm(true),
    ]);

    assert!(
        prompter
            .ask_typed_confirmation("Type \"local\"", "local", None)
            .unwrap()
    );
    assert!(
        !prompter
            .ask_typed_confirmation("Type \"local\"", "local", None)
            .unwrap()
    );
    assert!(
        !prompter
            .ask_typed_confirmation("Type \"local\"", "local", None)
            .unwrap()
    );
    assert!(matches!(
        prompter.ask_typed_confirmation("Type \"local\"", "local", None),
        Err(PromptError::Script(_))
    ));
    assert_eq!(
        prompter.asked()[0],
        Ask::TypedConfirmation {
            message: "Type \"local\"".to_owned(),
            expected: "local".to_owned(),
            current: None,
        }
    );
}
